import { mediaToDrop } from '../core/bounds';
import { classify, extensionOf, type Classification } from '../core/classify';
import { summarizeHls } from '../core/m3u8';
import { summarizeDash } from '../core/mpd';
import { hashString } from '../core/naming';
import { isExcludedFromStore, isFragmentSite } from '../core/sites';
import type { DetectedMedia } from '../core/types';
import { fetchWithHeaders, pickReplayHeaders } from './headers';
import { previewTab } from './previews';
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
		return { key: hashString(url), ext: found.ext, size: found.size, viaScript: found.viaScript, variants: [], hasVideo: !/^(mp3|m4a|aac|ogg|opus|wav|flac)$/.test(found.ext ?? '') };
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

/** A media item's address without its query string, which players vary between requests for the same thing. */
const addressOf = (media: DetectedMedia) => {
	if (media.kind === 'page') {
		return null;
	}
	const url = new URL(media.url);
	return `${media.kind} ${url.origin}${url.pathname}`;
};

const isManifest = (media: DetectedMedia) => media.kind === 'hls' || media.kind === 'dash';

const register = async (media: DetectedMedia) => {
	if (__STORE__ && isExcludedFromStore(media.url, media.pageUrl)) {
		return;
	}
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

		// Players often request one thing more than once with different query strings, and servers may answer each
		// with slightly different text. Same address apart from the query means same media.
		const address = addressOf(media);
		if (address && Object.values(tab).some(item => addressOf(item) === address)) {
			return;
		}

		// Once a tab has a manifest, the media files its player fetches are pieces of that stream.
		if (media.viaScript && Object.values(tab).some(isManifest)) {
			return;
		}
		if (isManifest(media)) {
			for (const item of Object.values(tab)) {
				if (item.viaScript) {
					delete tab[item.key];
				}
			}
		}

		tab[media.key] = media;
		for (const key of mediaToDrop(Object.values(tab), media.key)) {
			delete tab[key];
		}
	});
	await updateBadge(media.tabId);

	// Thumbnails and running times are read straight away for the tab in front, so the list is complete, and can
	// be filtered, the moment the popup opens.
	const tab = await chrome.tabs.get(media.tabId).catch(() => null);
	if (tab?.active) {
		void previewTab(media.tabId);
	}
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

	if (found.viaScript && isFragmentSite(details.initiator)) {
		return;
	}
	// Checked again in `register` against the tab's address; here it saves fetching YouTube's manifests at all.
	if (__STORE__ && isExcludedFromStore(details.url, details.initiator)) {
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

/**
 * Runs inside the page. Besides each media element's address and state, it looks for the title of what the element
 * is showing, because a tab's title says nothing about one video among several on a feed or profile page.
 */
const readMediaElements = () => {
	const sessionTitle = navigator.mediaSession?.metadata?.title?.trim() || '';

	// Players overlay the description on the picture. Taking the nearest container that is no bigger than the
	// picture keeps to that overlay and away from comments and recommendations around the player.
	const overlayTitle = (element: Element): string => {
		const box = element.getBoundingClientRect();
		const area = box.width * box.height;
		if (area === 0) {
			return '';
		}

		for (let node = element.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
			const rect = node.getBoundingClientRect();
			if (rect.width * rect.height > area * 1.5) {
				break;
			}
			// Status messages over the picture ("resumed at 16:59", a counter) are short or carry a clock time; a
			// description is a proper sentence. Only the latter is taken, from the nearest container that has one.
			const isProse = (line: string, minimum: number) => line.length >= minimum && !/\d{1,2}:\d{2}/.test(line) && !line.startsWith('@');
			const lines = node.innerText.split('\n').map(line => line.trim());
			const longest = lines.filter(line => isProse(line, 16)).reduce((best, line) => (line.length > best.length ? line : best), '');
			if (!longest) {
				continue;
			}

			// The longest line sits in the description. A description opens with its headline, so the title is
			// the first of the run of text lines that the longest one belongs to.
			// Short lines before it (an author's handle, a date) are not part of the description.
			let first = lines.indexOf(longest);
			while (first > 0 && isProse(lines[first - 1]!, 12)) {
				first--;
			}
			const title = lines[first]!;
			return title.replace(/\s+/g, ' ').slice(0, 120);
		}
		return '';
	};

	const inView = (element: Element) => {
		const box = element.getBoundingClientRect();
		return box.width >= 160 && box.height >= 90 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
	};

	const elements = [...document.querySelectorAll<HTMLMediaElement>('video, audio')];
	const playingCount = elements.filter(element => !element.paused && !element.ended).length;
	return elements.map(element => {
		const playing = !element.paused && !element.ended;
		// The video the user is looking at stays the current one when paused; preloaded ones were never started.
		const current = playing || (element.currentTime > 0 && inView(element));
		return {
			url: element.currentSrc || element.src || element.querySelector('source')?.src || '',
			video: element instanceof HTMLVideoElement,
			duration: Number.isFinite(element.duration) ? element.duration : undefined,
			playing,
			current,
			// What the page declares as now playing is only attributable when a single element is playing.
			title: current ? (playing && playingCount === 1 && sessionTitle) || overlayTitle(element) : '',
			page: location.href,
		};
	});
};

/**
 * Lists the media elements already on the page. This covers what network detection misses: media that started
 * before the extension was loaded, came from the browser cache, or has not been played yet.
 */
export const scanPage = async (tabId: number) => {
	if (__STORE__ && isExcludedFromStore((await chrome.tabs.get(tabId).catch(() => null))?.url)) {
		return;
	}
	const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: readMediaElements }).catch(() => []);

	const elements = results.flatMap(frame => frame.result ?? []);
	// Players that feed the element through a blob hide its address, but the running time still identifies which
	// of the detected files is the one on screen.
	await mutate(state => {
		state.onScreen[tabId] = elements.flatMap(element => (
			element.current && element.duration ? [{ duration: element.duration, playing: element.playing }] : []
		));
		// A title belongs to the item with the running time of the element it was read beside.
		for (const element of elements) {
			if (!element.title || !element.duration) {
				continue;
			}
			for (const item of Object.values(state.media[tabId] ?? {})) {
				if (item.kind !== 'page' && item.duration !== undefined && Math.abs(item.duration - element.duration) < 0.5) {
					item.title = element.title;
				}
			}
		}
	});

	const tab = await chrome.tabs.get(tabId).catch(() => null);
	for (const element of elements) {
		if (!/^https?:/.test(element.url)) {
			continue;
		}
		const ext = extensionOf(element.url);
		if (ext === 'm3u8' || ext === 'mpd') {
			continue;
		}
		await register({
			key: hashString(element.url),
			kind: 'file',
			url: element.url,
			tabId,
			pageUrl: tab?.url,
			pageTitle: tab?.title,
			replayHeaders: { referer: element.page },
			ext: ext ?? 'mp4',
			duration: element.duration,
			variants: [],
			hasVideo: element.video,
			detectedAt: Date.now(),
		});
	}
};

export const forgetTab = async (tabId: number) => {
	await mutate(state => {
		delete state.media[tabId];
		delete state.probes[tabId];
		delete state.onScreen[tabId];
	});
	await updateBadge(tabId);
};
