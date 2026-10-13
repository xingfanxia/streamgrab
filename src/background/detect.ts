import { classify, type Classification } from '../core/classify';
import { summarizeHls } from '../core/m3u8';
import { summarizeDash } from '../core/mpd';
import { hashString } from '../core/naming';
import type { DetectedMedia } from '../core/types';
import { fetchWithHeaders, pickReplayHeaders } from './headers';
import { mutate } from './state';

/** Request headers by request id, held between `onSendHeaders` and `onResponseStarted`. */
const sentHeaders = new Map<string, Record<string, string>>();
const MAX_PENDING = 2000;

const resolve = (uri: string, base: string) => {
	try {
		return new URL(uri, base).href;
	} catch {
		return null;
	}
};

const resolveAll = (uris: string[], base: string) => uris.flatMap(uri => resolve(uri, base) ?? []);

const describe = async (
	found: Classification,
	url: string,
	replayHeaders: Record<string, string>,
): Promise<Partial<DetectedMedia> & { key: string } | null> => {
	if (found.kind === 'file') {
		return { key: hashString(url), ext: found.ext, size: found.size, variants: [], hasVideo: !/^(mp3|m4a|aac|ogg|opus|wav|flac)$/.test(found.ext ?? '') };
	}

	const text = await (await fetchWithHeaders(url, replayHeaders)).text();
	if (found.kind === 'hls') {
		const summary = summarizeHls(text);
		if (!summary) {
			return null;
		}
		return {
			key: hashString(text),
			variants: summary.variants,
			duration: summary.duration,
			live: summary.live,
			drm: summary.drm,
			hasVideo: summary.hasVideo,
			childUrls: summary.isMaster ? resolveAll(summary.childUris, url) : undefined,
			subtitles: summary.subtitles.flatMap(({ label, uri }) => {
				const resolved = resolve(uri, url);
				return resolved ? [{ label, url: resolved }] : [];
			}),
		};
	}

	const summary = summarizeDash(text, url);
	if (!summary) {
		return null;
	}
	return {
		key: hashString(text),
		// Tracks carry their full segment lists, which are re-derived at download time rather than stored.
		variants: summary.videos.map(({ id, width, height, bitrate, codecs }) => ({ id, width, height, bitrate, codecs })),
		duration: summary.duration,
		live: summary.live,
		drm: summary.drm,
		hasVideo: summary.videos.length > 0,
	};
};

const manifestAddress = (media: DetectedMedia) => {
	if (media.kind !== 'hls' && media.kind !== 'dash') {
		return null;
	}
	const url = new URL(media.url);
	return url.origin + url.pathname;
};

const register = async (media: DetectedMedia) => {
	await mutate(state => {
		const tab = state.media[media.tabId] ??= {};
		if (tab[media.key]) {
			return;
		}

		// A media playlist that belongs to a master already listed (or arriving now) is not a separate item.
		const masters = Object.values(tab).filter(item => item.childUrls);
		if (media.kind === 'hls' && !media.childUrls && masters.some(master => master.childUrls!.includes(media.url))) {
			return;
		}
		for (const item of Object.values(tab)) {
			if (media.childUrls?.includes(item.url)) {
				delete tab[item.key];
			}
		}

		// Players often request one stream's manifest more than once with different query strings, and servers may
		// answer each with slightly different text. Same address apart from the query means same stream.
		const address = manifestAddress(media);
		if (address && Object.values(tab).some(item => manifestAddress(item) === address)) {
			return;
		}

		tab[media.key] = media;
	});
	await updateBadge(media.tabId);
};

export const updateBadge = async (tabId: number) => {
	const count = await mutate(state => Object.keys(state.media[tabId] ?? {}).length);
	await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
	await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }).catch(() => {});
};

const isOwnRequest = (details: { tabId: number; initiator?: string }) => (
	details.tabId < 0 || details.initiator?.startsWith('chrome-extension://')
);

export const onSendHeaders = (details: chrome.webRequest.OnSendHeadersDetails) => {
	if (isOwnRequest(details)) {
		return;
	}
	if (sentHeaders.size >= MAX_PENDING) {
		sentHeaders.delete(sentHeaders.keys().next().value!);
	}
	sentHeaders.set(details.requestId, pickReplayHeaders(details.requestHeaders));
};

export const onRequestFinished = (details: { requestId: string }) => {
	// Deferred so `onResponseStarted` for the same request can still read the headers.
	setTimeout(() => sentHeaders.delete(details.requestId), 5000);
};

export const onResponseStarted = async (details: chrome.webRequest.OnResponseStartedDetails) => {
	if (isOwnRequest(details)) {
		return;
	}

	const headers: Record<string, string> = {};
	for (const header of details.responseHeaders ?? []) {
		headers[header.name.toLowerCase()] = header.value ?? '';
	}
	const found = classify({ url: details.url, type: details.type, statusCode: details.statusCode, headers });
	if (!found) {
		return;
	}

	const replayHeaders = sentHeaders.get(details.requestId) ?? {};
	try {
		const described = await describe(found, details.url, replayHeaders);
		if (!described) {
			return;
		}

		const tab = await chrome.tabs.get(details.tabId).catch(() => null);
		await register({
			variants: [],
			hasVideo: true,
			...described,
			kind: found.kind,
			url: details.url,
			tabId: details.tabId,
			pageUrl: tab?.url,
			pageTitle: tab?.title,
			replayHeaders,
			detectedAt: Date.now(),
		});
	} catch (error) {
		console.warn('streamgrab: could not inspect', details.url, error);
	}
};

export const forgetTab = async (tabId: number) => {
	await mutate(state => {
		delete state.media[tabId];
		delete state.probes[tabId];
	});
	await updateBadge(tabId);
};
