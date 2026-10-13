import { hashString } from '../core/naming';
import { pageUrlForYtDlp } from '../core/sites';
import type { DetectedMedia, Variant } from '../core/types';
import type { Probe, UiCommand } from '../shared/messages';
import { loadState, mutate } from './state';

// Bridge to the locally installed yt-dlp through the native messaging host in `native/host.mjs`. It covers sites
// whose media cannot be picked off the network as a file or a standard manifest.

const HOST = 'io.github.xingfanxia.streamgrab';

type HostInfo = {
	type: 'info';
	id: string;
	title: string;
	site: string;
	duration?: number;
	live: boolean;
	heights: number[];
	hasVideo: boolean;
	thumbnail?: string;
	bitrates?: Record<string, number>;
	subtitles: { language: string; automatic: boolean }[];
};
type HostMessage =
	| HostInfo
	| { type: 'progress'; bytes: number; fraction: number | null }
	| { type: 'done'; files: string[]; bytes: number }
	| { type: 'error'; message: string };

const ports = new Map<string, chrome.runtime.Port>();

/** The browser's cookies for the page, so yt-dlp sees the same login the user has in this profile. */
const cookiesFor = (url: string) => chrome.cookies.getAll({ url });

/**
 * Sends one request to the host and reports its messages. Resolves with the final message, or with `missing` when
 * the host is not installed. Disconnecting the returned port cancels the request.
 */
const call = (
	request: Record<string, unknown>,
	onProgress: (message: Extract<HostMessage, { type: 'progress' }>) => void,
	onPort?: (port: chrome.runtime.Port) => void,
) => new Promise<Exclude<HostMessage, { type: 'progress' }> | { type: 'missing' } | { type: 'canceled' }>(resolve => {
	const port = chrome.runtime.connectNative(HOST);
	onPort?.(port);
	let settled = false;

	port.onMessage.addListener((message: HostMessage) => {
		if (message.type === 'progress') {
			onProgress(message);
			return;
		}
		settled = true;
		resolve(message);
		port.disconnect();
	});
	port.onDisconnect.addListener(() => {
		if (settled) {
			return;
		}
		const reason = chrome.runtime.lastError?.message ?? '';
		resolve(/not found|forbidden/i.test(reason) ? { type: 'missing' } : { type: 'error', message: reason || 'yt-dlp stopped unexpectedly' });
	});
	port.postMessage(request);
});

const setProbe = (tabId: number, probe: Probe) => mutate(state => {
	state.probes[tabId] = probe;
});

export const probePage = async (tabId: number) => {
	const tab = await chrome.tabs.get(tabId).catch(() => null);
	const url = tab?.url;
	if (!url || !/^https?:/.test(url)) {
		return;
	}
	const state = await loadState();
	const previous = state.probes[tabId];
	if (previous?.url === url && previous.status !== 'missing') {
		return;
	}

	await setProbe(tabId, { url, status: 'running' });
	const reply = await call({ op: 'probe', url: pageUrlForYtDlp(url), cookies: await cookiesFor(url) }, () => {});
	if (reply.type !== 'info') {
		await setProbe(tabId, {
			url,
			status: reply.type === 'missing' ? 'missing' : 'failed',
			message: reply.type === 'error' ? reply.message : undefined,
		});
		return;
	}

	const variants: Variant[] = reply.heights.map(height => ({ id: String(height), height, bitrate: reply.bitrates?.[height] }));

	// When yt-dlp reports no cover, the page usually names one itself.
	const cover = reply.thumbnail ?? await chrome.scripting.executeScript({
		target: { tabId },
		func: () => document.querySelector<HTMLMetaElement>('meta[property="og:image"], meta[name="og:image"]')?.content
			|| document.querySelector<HTMLVideoElement>('video[poster]')?.poster
			|| '',
	}).then(results => results[0]?.result || undefined, () => undefined);
	const media: DetectedMedia = {
		key: `page-${hashString(url)}`,
		kind: 'page',
		url,
		tabId,
		pageUrl: url,
		pageTitle: reply.title,
		site: reply.site,
		replayHeaders: {},
		duration: reply.duration,
		live: reply.live,
		variants,
		hasVideo: reply.hasVideo,
		thumbnail: cover?.replace(/^http:/, 'https:'),
		previewed: true,
		subtitles: reply.subtitles.map(({ language, automatic }) => ({
			label: automatic ? `${language} (auto)` : language,
			url: `${automatic ? 'auto' : 'manual'}:${language}`,
		})),
		detectedAt: Date.now(),
	};
	await mutate(current => {
		(current.media[tabId] ??= {})[media.key] = media;
		current.probes[tabId] = { url, status: 'found' };
	});
};

export const startPageDownload = async (media: DetectedMedia, command: Extract<UiCommand, { type: 'download' }>) => {
	const jobId = crypto.randomUUID();
	const subtitle = media.subtitles?.find(track => track.url === command.subtitleUrl);
	const title = media.pageTitle || new URL(media.url).hostname;

	await mutate(state => {
		state.jobs[jobId] = {
			id: jobId,
			mediaKey: media.key,
			tabId: media.tabId,
			title,
			filename: subtitle ? `${title} (${subtitle.label})` : title,
			state: 'running',
			progress: media.live ? null : 0,
			bytes: 0,
			startedAt: Date.now(),
		};
	});

	const [mode, language] = subtitle?.url.split(':') ?? [];
	const reply = await call({
		op: 'download',
		url: pageUrlForYtDlp(media.url),
		height: command.variantId ? Number(command.variantId) : null,
		audioOnly: command.audioOnly,
		subtitle: subtitle ? { language, automatic: mode === 'auto' } : null,
		cookies: await cookiesFor(media.url),
	}, progress => {
		void mutate(state => {
			const job = state.jobs[jobId];
			if (job?.state === 'running') {
				job.progress = media.live ? null : progress.fraction;
				job.bytes = Math.max(job.bytes, progress.bytes);
			}
		});
	}, port => ports.set(jobId, port));
	ports.delete(jobId);

	await mutate(state => {
		const job = state.jobs[jobId];
		if (!job || job.state !== 'running') {
			return;
		}
		if (reply.type === 'done') {
			job.state = 'done';
			job.progress = 1;
			job.path = reply.files.at(-1)!;
			job.filename = job.path.split('/').pop()!;
			job.bytes = reply.bytes || job.bytes;
		} else {
			job.state = 'failed';
			job.error = reply.type === 'error' ? reply.message : 'the yt-dlp bridge is not installed';
		}
	});
};

/** Shows a file yt-dlp saved in the system file manager. */
export const revealPath = (path: string) => call({ op: 'reveal', path }, () => {});

/** Cancels a yt-dlp download; returns false when the job is not one of these. */
export const stopPageDownload = (jobId: string) => {
	const port = ports.get(jobId);
	if (!port) {
		return false;
	}
	ports.delete(jobId);
	port.disconnect();
	void mutate(state => {
		const job = state.jobs[jobId];
		if (job) {
			job.state = 'canceled';
		}
	});
	return true;
};
