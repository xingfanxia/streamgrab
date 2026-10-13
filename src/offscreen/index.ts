import { StreamTarget } from 'mediabunny';
import { listSegmentUris } from '../core/m3u8';
import { summarizeDash } from '../core/mpd';
import { mergeVtt } from '../core/vtt';
import type { JobRequest } from '../core/types';
import { fetchOk, withRetry } from '../engine/fetching';
import { downloadFile } from '../engine/file';
import { downloadDash, downloadHls, type EngineHooks } from '../engine/remux';
import { isEngineCommand, type EngineEvent } from '../shared/messages';

type Running = {
	stop: AbortController;
	/** Whether a stopped job should still be delivered as a (partial) file. */
	keep: boolean;
	blobUrl?: string;
	opfsName: string;
};

const running = new Map<string, Running>();

const send = (event: EngineEvent) => chrome.runtime.sendMessage(event);

const makeFetch = (jobId: string): typeof fetch => {
	const knownHosts = new Set<string>();
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.protocol.startsWith('http') && !knownHosts.has(url.host)) {
			await send({ from: 'engine', type: 'host', jobId, host: url.host });
			knownHosts.add(url.host);
		}
		return fetch(input, { ...init, credentials: 'include' });
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
		if (request.kind === 'file') {
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
	try {
		const file = await root.getFileHandle(request.opfsName, { create: true });
		const hooks: EngineHooks = {
			fetchFn: makeFetch(request.jobId),
			stopSignal: job.stop.signal,
			onProgress: fraction => {
				progress = fraction;
				report();
			},
		};
		await execute(request, hooks, file, end => {
			bytes = Math.max(bytes, end);
			report();
		});

		if (!job.keep || bytes === 0) {
			throw new DOMException('Canceled', 'AbortError');
		}
		job.blobUrl = URL.createObjectURL(await file.getFile());
		await send({ from: 'engine', type: 'done', jobId: request.jobId, blobUrl: job.blobUrl, bytes });
	} catch (error) {
		await root.removeEntry(request.opfsName).catch(() => {});
		running.delete(request.jobId);
		if (job.stop.signal.aborted) {
			await send({ from: 'engine', type: 'canceled', jobId: request.jobId });
		} else {
			console.error(error);
			await send({ from: 'engine', type: 'failed', jobId: request.jobId, error: error instanceof Error ? error.message : String(error) });
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
	} else {
		// Answered only once the file is gone, because the service worker closes this document right after.
		void release(message.jobId).finally(() => respond(true));
		return true;
	}
	return false;
});
