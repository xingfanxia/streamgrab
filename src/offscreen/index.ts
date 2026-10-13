import { StreamTarget } from 'mediabunny';
import { listSegmentUris } from '../core/m3u8';
import { summarizeDash } from '../core/mpd';
import { mergeVtt } from '../core/vtt';
import type { JobRequest } from '../core/types';
import { fetchOk, withRetry } from '../engine/fetching';
import { downloadFile } from '../engine/file';
import { makePreview } from '../engine/preview';
import { createTurns } from '../engine/turns';
import { downloadDash, downloadHls, downloadPair, type EngineHooks } from '../engine/remux';
import { isEngineCommand, type EngineEvent, type Preview } from '../shared/messages';

type Running = {
	stop: AbortController;
	/** Whether a stopped job should still be delivered as a (partial) file. */
	keep: boolean;
	blobUrl?: string;
	opfsName: string;
};

const running = new Map<string, Running>();

/** Transfers allowed at once from a server that has given no reason for fewer. */
const DEFAULT_PER_SERVER = 5;
/** Times a transfer may be cut off, with others running beside it, before the server is taken to be crowded. */
const CUTS_BEFORE_BACKING_OFF = 3;
const LEARNED_KEY = 'serverLimits';
const LEARNED_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Limits learned for servers that cut connections, kept for a week. This document is closed whenever nothing is
 * downloading, so without keeping them every session would have to find the limit out again.
 */
const readLearned = (): Record<string, { limit: number; at: number }> => {
	try {
		const stored = JSON.parse(localStorage.getItem(LEARNED_KEY) ?? '{}') as Record<string, { limit: number; at: number }>;
		return Object.fromEntries(Object.entries(stored).filter(([, entry]) => Date.now() - entry.at < LEARNED_FOR_MS));
	} catch {
		return {};
	}
};

const turns = createTurns(
	DEFAULT_PER_SERVER,
	Object.fromEntries(Object.entries(readLearned()).map(([host, entry]) => [host, entry.limit])),
);

/** Lowers a server's limit to one fewer than are running now, and remembers it. */
const backOff = (host: string) => {
	const limit = Math.max(1, Math.min(turns.limitOf(host), turns.active(host)) - 1);
	turns.setLimit(host, limit);
	localStorage.setItem(LEARNED_KEY, JSON.stringify({ ...readLearned(), [host]: { limit, at: Date.now() } }));
};

const send = (event: EngineEvent) => chrome.runtime.sendMessage(event);

/** One request as it went: enough to see how a server behaved, without cookies or signed query strings. */
type RequestNote = {
	at: number;
	url: string;
	range?: string;
	status?: number;
	headers?: Record<string, string>;
	bytes: number;
	error?: string;
};

const NOTED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'server', 'retry-after'];
const MAX_NOTES = 60;

/**
 * The fetch every job uses: asks for the job's header rule to cover each new host, sends cookies, and keeps a short
 * record of what came back so a failure can be diagnosed from the user's own browser.
 */
const makeFetch = (jobId: string, notes: RequestNote[] = [], onCut: () => void = () => {}): typeof fetch => {
	const knownHosts = new Set<string>();
	const started = Date.now();
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.protocol.startsWith('http') && !knownHosts.has(url.host)) {
			await send({ from: 'engine', type: 'host', jobId, host: url.host });
			knownHosts.add(url.host);
		}

		const note: RequestNote = {
			at: Date.now() - started,
			url: `${url.host}${url.pathname.replace(/[^/]{24,}/g, part => `${part.slice(0, 8)}…${part.slice(-8)}`)}`,
			range: new Headers(init?.headers).get('range') ?? undefined,
			bytes: 0,
		};
		notes.push(note);
		if (notes.length > MAX_NOTES) {
			notes.splice(4, notes.length - MAX_NOTES);
		}

		let response: Response;
		try {
			response = await fetch(input, { ...init, credentials: 'include' });
		} catch (error) {
			note.error = `request: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
			if (!init?.signal?.aborted) {
				onCut();
			}
			throw error;
		}
		note.status = response.status;
		note.headers = Object.fromEntries(NOTED_HEADERS.flatMap(name => {
			const value = response.headers.get(name);
			return value ? [[name, value]] : [];
		}));
		if (!response.body) {
			return response;
		}

		// The body is passed through unchanged; counting it shows how far a transfer got before it broke.
		const reader = response.body.getReader();
		const counted = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
					} else {
						note.bytes += value.byteLength;
						controller.enqueue(value);
					}
				} catch (error) {
					note.error = `body: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
					if (!init?.signal?.aborted) {
						onCut();
					}
					controller.error(error);
				}
			},
			cancel: reason => reader.cancel(reason),
		});
		const wrapped = new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
		Object.defineProperty(wrapped, 'url', { value: response.url });
		return wrapped;
	};
};

const execute = async (
	request: JobRequest,
	hooks: EngineHooks,
	file: FileSystemFileHandle,
	noteBytes: (end: number) => void,
) => {
	const writable = await file.createWritable();
	let position = 0;

	try {
		if (request.kind === 'file' && !request.audioUrl) {
			await downloadFile(request.url, async chunk => {
				await writable.write(chunk);
				noteBytes(position += chunk.byteLength);
			}, hooks);
			await writable.close();
			return;
		}

		if (request.kind === 'subtitles') {
			const playlist = await fetchOk(hooks.fetchFn, request.url);
			const uris = listSegmentUris(await playlist.text());
			const segments: string[] = [];
			for (const uri of uris) {
				const url = new URL(uri, request.url).href;
				segments.push(await withRetry(async () => (await fetchOk(hooks.fetchFn, url, { signal: hooks.stopSignal })).text()));
				hooks.onProgress(segments.length / uris.length);
			}
			const bytes = new TextEncoder().encode(mergeVtt(segments));
			await writable.write(bytes);
			noteBytes(bytes.byteLength);
			await writable.close();
			return;
		}

		const target = new StreamTarget(new WritableStream({
			write: async chunk => {
				await writable.write(chunk);
				noteBytes(chunk.position + chunk.data.byteLength);
			},
			close: () => writable.close(),
			abort: reason => writable.abort(reason),
		}));

		if (request.kind === 'file') {
			await downloadPair(request.url, request.audioUrl!, target, hooks);
			return;
		}

		if (request.kind === 'hls') {
			await downloadHls({
				url: request.url,
				height: request.variant?.height ?? null,
				audioOnly: request.audioOnly,
				live: request.live,
			}, target, hooks);
			return;
		}

		const manifest = await hooks.fetchFn(request.url);
		const summary = summarizeDash(await manifest.text(), manifest.url || request.url);
		if (!summary) {
			throw new Error('The DASH manifest could not be read');
		}
		const video = request.audioOnly
			? null
			: summary.videos.find(track => track.id === request.variant?.id) ?? summary.videos[0] ?? null;
		await downloadDash(video, summary.audios[0] ?? null, target, hooks);
	} catch (error) {
		await writable.abort().catch(() => {});
		throw error;
	}
};

const run = async (request: JobRequest) => {
	const job: Running = { stop: new AbortController(), keep: true, opfsName: request.opfsName };
	running.set(request.jobId, job);

	const notes: RequestNote[] = [];
	let bytes = 0;
	let progress: number | null = null;
	let lastSent = 0;
	const report = (force = false) => {
		const now = Date.now();
		if (force || now - lastSent > 500) {
			lastSent = now;
			void send({ from: 'engine', type: 'progress', jobId: request.jobId, progress, bytes });
		}
	};

	const root = await navigator.storage.getDirectory();
	const host = new URL(request.url).host;
	let endTurn = () => {};
	try {
		let file: FileSystemFileHandle;
		for (;;) {
			endTurn = await turns.take(host, job.stop.signal);
			await send({ from: 'engine', type: 'started', jobId: request.jobId });
			file = await root.getFileHandle(request.opfsName, { create: true });

			// A transfer that keeps getting cut off while others from the same server run beside it is taken as
			// the sign that the server allows fewer at once: it stops, the limit drops, and it waits its turn.
			const crowded = new AbortController();
			let cuts = 0;
			const hooks: EngineHooks = {
				fetchFn: makeFetch(request.jobId, notes, () => {
					if (++cuts >= CUTS_BEFORE_BACKING_OFF && turns.active(host) > 1) {
						crowded.abort();
					}
				}),
				stopSignal: AbortSignal.any([job.stop.signal, crowded.signal]),
				onProgress: fraction => {
					progress = fraction;
					report();
				},
			};
			try {
				await execute(request, hooks, file, end => {
					bytes = Math.max(bytes, end);
					report();
				});
				if (!crowded.signal.aborted) {
					break;
				}
			} catch (error) {
				if (job.stop.signal.aborted || !crowded.signal.aborted) {
					throw error;
				}
			}

			backOff(host);
			endTurn();
			endTurn = () => {};
			await root.removeEntry(request.opfsName).catch(() => {});
			bytes = 0;
			progress = 0;
			await send({ from: 'engine', type: 'waiting', jobId: request.jobId });
		}

		if (!job.keep || bytes === 0) {
			throw new DOMException('Canceled', 'AbortError');
		}
		endTurn();
		endTurn = () => {};
		job.blobUrl = URL.createObjectURL(await file.getFile());
		await send({ from: 'engine', type: 'done', jobId: request.jobId, blobUrl: job.blobUrl, bytes });
	} catch (error) {
		endTurn();
		await root.removeEntry(request.opfsName).catch(() => {});
		running.delete(request.jobId);
		if (job.stop.signal.aborted) {
			await send({ from: 'engine', type: 'canceled', jobId: request.jobId });
		} else {
			console.error(error);
			// Browsers report a broken connection only as "network error"; naming the server makes it actionable.
			const reason = error instanceof Error ? error.message : String(error);
			const details = JSON.stringify({
				kind: request.kind,
				paired: Boolean(request.audioUrl),
				error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
				bytesWritten: bytes,
				online: navigator.onLine,
				requests: notes,
			}, null, 1);
			await send({ from: 'engine', type: 'failed', jobId: request.jobId, error: `${reason} (${new URL(request.url).host})`, details });
		}
	}
};

/** Frees the finished file once the browser has copied it into the downloads folder. */
const release = async (jobId: string) => {
	const job = running.get(jobId);
	if (!job) {
		return;
	}
	running.delete(jobId);
	if (job.blobUrl) {
		URL.revokeObjectURL(job.blobUrl);
	}
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(job.opfsName).catch(() => {});
};

chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
	if (!isEngineCommand(message)) {
		return false;
	}

	if (message.type === 'run') {
		void run(message.request);
	} else if (message.type === 'stop') {
		const job = running.get(message.jobId);
		if (job) {
			job.keep = message.keep;
			job.stop.abort();
		}
	} else if (message.type === 'preview') {
		const timeout = new Promise<Preview>(resolve => setTimeout(() => resolve({}), 20_000));
		void Promise.race([makePreview(message.kind, message.url, makeFetch(message.id)), timeout])
			.catch((): Preview => ({}))
			.then(respond);
		return true;
	} else {
		// Answered only once the file is gone, because the service worker closes this document right after.
		void release(message.jobId).finally(() => respond(true));
		return true;
	}
	return false;
});
