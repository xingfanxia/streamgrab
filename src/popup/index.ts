import { arrange, DEFAULT_PREFS, estimateSize, isPlaying, type ListPrefs } from '../core/arrange';
import { cleanTitle } from '../core/naming';
import { isPageSite } from '../core/sites';
import type { DetectedMedia, Job, Variant } from '../core/types';
import { emptyState, STATE_KEY, type State, type UiCommand } from '../shared/messages';

const t = (key: string, substitution?: string) => chrome.i18n.getMessage(key, substitution);
const send = (command: UiCommand) => chrome.runtime.sendMessage(command);
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const mediaList = byId<HTMLUListElement>('media');
const jobList = byId<HTMLUListElement>('jobs');
const finishedList = byId<HTMLUListElement>('finished');
const tray = byId('tray');
const emptyNote = byId('empty');
const probeNote = byId('probe');
const filters = byId('filters');
const hiddenNote = byId('hidden-note');
const sortSelect = byId<HTMLSelectElement>('sort');
const durationSelect = byId<HTMLSelectElement>('min-duration');

const PREFS_KEY = 'listPrefs';
let prefs: ListPrefs = DEFAULT_PREFS;

/** Whether the items that are not playing have been asked for; a feed preloads many the user never looked at. */
let showOthers = false;

/** Media whose list of other ways to save is open, kept across re-renders. */
const expanded = new Set<string>();
let renderedMedia = '';

const el = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Record<string, unknown> & { testid?: string } = {},
	children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
	const { testid, ...rest } = props;
	const node = Object.assign(document.createElement(tag), rest);
	if (testid) {
		node.dataset.testid = testid;
	}
	node.append(...children);
	return node;
};

const formatBytes = (bytes: number) => {
	if (bytes < 1e6) {
		return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
	}
	return bytes < 1e9 ? `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB` : `${(bytes / 1e9).toFixed(2)} GB`;
};

const formatDuration = (seconds: number) => {
	const whole = Math.round(seconds);
	const parts = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
	const shown = parts[0] ? parts : parts.slice(1);
	return shown.map((part, i) => (i === 0 ? String(part) : String(part).padStart(2, '0'))).join(':');
};

const kindTag = (media: DetectedMedia) => {
	if (media.kind === 'page') {
		return media.site || 'yt-dlp';
	}
	return media.kind === 'file' ? (media.ext ?? 'file').toUpperCase() : media.kind.toUpperCase();
};

const qualityLabel = (variant: Variant) => {
	if (variant.height) {
		// The shorter side is what people mean by "1080p", including for upright video.
		return `${Math.min(variant.height, variant.width ?? variant.height)}p`;
	}
	return variant.bitrate ? `${Math.round(variant.bitrate / 1000)} kbps` : variant.id;
};

const sizeLabel = (media: DetectedMedia, variant?: Variant) => {
	const size = estimateSize(media, variant);
	return size ? `${size.exact ? '' : '~'}${formatBytes(size.bytes)}` : '';
};

const fileNameOf = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop() || url);

const start = (media: DetectedMedia, options: { variantId?: string | null; audioOnly?: boolean; subtitleUrl?: string }) => send({
	type: 'download',
	tabId: media.tabId,
	key: media.key,
	variantId: options.variantId ?? media.variants[0]?.id ?? null,
	audioOnly: options.audioOnly ?? false,
	subtitleUrl: options.subtitleUrl,
});

/** One other way to save an item: a quality, the audio alone, or a subtitle track. */
const optionRow = (label: string, detail: string, testid: string, onPick: () => void) => (
	el('button', { className: 'option', testid, onclick: onPick }, [
		el('span', { className: 'what', textContent: label }),
		el('span', { className: 'detail', textContent: detail }),
	])
);

const renderOptions = (media: DetectedMedia) => {
	const rows: HTMLElement[] = [];
	if (media.variants.length > 1) {
		for (const variant of media.variants) {
			const rate = variant.bitrate ? `${(variant.bitrate / 1e6).toFixed(1)} Mbps` : '';
			const row = optionRow(qualityLabel(variant), [rate, sizeLabel(media, variant)].filter(Boolean).join('   '), 'quality', () => start(media, { variantId: variant.id }));
			row.dataset.height = String(variant.height ?? '');
			rows.push(row);
		}
	}
	if (media.hasVideo && media.kind !== 'file') {
		rows.push(optionRow(t('audioOnly'), 'M4A', 'audio-only', () => start(media, { audioOnly: true })));
	}
	for (const track of media.subtitles ?? []) {
		rows.push(optionRow(t('subtitlesIn', track.label), media.kind === 'page' ? 'SRT' : 'VTT', 'subtitle', () => start(media, { subtitleUrl: track.url })));
	}
	return rows;
};

const renderMediaItem = (media: DetectedMedia, tabTitle: string, mark: 'playing' | 'paused' | null) => {
	// Network-detected media carries no title of its own, so it takes the tab's current one, as the saved file will.
	const title = media.title || (media.kind === 'page' ? media.pageTitle : cleanTitle(tabTitle) || media.pageTitle) || fileNameOf(media.url);

	const shot = el('div', { className: 'shot' });
	if (media.thumbnail) {
		// Remote covers are requested without a referrer, which image hosts that guard against embedding accept.
		const image = el('img', { src: media.thumbnail, alt: '', referrerPolicy: 'no-referrer', testid: 'thumbnail' });
		image.addEventListener('error', () => image.remove());
		shot.append(image);
	} else if (!media.hasVideo) {
		shot.classList.add('audio');
	}
	shot.append(el('span', { className: 'tag', textContent: kindTag(media) }));
	if (media.live) {
		shot.append(el('span', { className: 'time live', textContent: t('live') }));
	} else if (media.duration) {
		shot.append(el('span', { className: 'time', textContent: formatDuration(media.duration), testid: 'duration' }));
	}

	const best = media.variants[0];
	const silent = media.tracks === 'video' && !media.audioUrl;
	const facts = [best && media.hasVideo ? qualityLabel(best) : '', sizeLabel(media, best), media.hasVideo ? '' : t('kindAudio'), silent ? t('noSound') : ''].filter(Boolean);
	const body = el('div', { className: 'body' }, [
		el('div', { className: 'title', textContent: title, title }),
		el('div', { className: 'facts' }, facts.map((fact, index) => el('span', { textContent: fact, testid: index === 1 || facts.length === 1 ? 'size' : '' }))),
	]);

	const item = el('li', { className: 'item', testid: 'media-item' }, [shot, body]);
	item.dataset.kind = media.kind;
	if (media.audioUrl) {
		item.dataset.paired = '';
	}
	if (mark) {
		item.classList.add('playing');
		shot.append(el('span', { className: 'now', textContent: t(mark === 'playing' ? 'playingNow' : 'onScreen'), testid: 'playing' }));
	}

	if (media.drm) {
		body.append(el('p', { className: 'blocked', textContent: t('blocked', media.drm), testid: 'blocked' }));
		return item;
	}

	const actions = el('div', { className: 'actions' }, [
		el('button', {
			className: 'primary',
			textContent: media.live ? t('record') : t('download'),
			testid: 'download',
			onclick: () => start(media, {}),
		}),
	]);
	body.append(actions);

	const options = renderOptions(media);
	if (options.length > 0) {
		const panel = el('div', { className: 'options', testid: 'options' }, options);
		const toggle = el('button', { className: 'more', textContent: t('otherWays'), testid: 'more' });
		const sync = () => {
			const open = expanded.has(media.key);
			panel.hidden = !open;
			toggle.setAttribute('aria-expanded', String(open));
		};
		toggle.addEventListener('click', () => {
			if (!expanded.delete(media.key)) {
				expanded.add(media.key);
			}
			sync();
		});
		sync();
		actions.append(toggle);
		item.append(panel);
	}
	return item;
};

const jobStatus = (job: Job) => {
	if (job.state === 'failed') {
		return t('stateFailed', job.error ?? '');
	}
	if (job.state === 'running') {
		const label = job.progress === null ? t('stateRecording') : `${Math.round(job.progress * 100)}%`;
		return `${label}   ${formatBytes(job.bytes)}`;
	}
	if (job.state === 'done') {
		return formatBytes(job.bytes);
	}
	return t({ saving: 'stateSaving', canceled: 'stateCanceled', queued: 'stateQueued' }[job.state]);
};

const renderRunning = (job: Job) => {
	const bar = el('div', { className: 'segments' });
	if (job.state === 'running' && job.progress === null) {
		bar.classList.add('unknown');
	} else {
		bar.style.setProperty('--filled', `${Math.round((job.state === 'saving' ? 1 : job.progress ?? 0) * 100)}%`);
	}

	const live = job.progress === null;
	const line = el('div', { className: 'line' }, [
		el('span', { className: 'title', textContent: job.filename, title: job.filename }),
		el('span', { className: 'status', textContent: jobStatus(job), testid: 'job-status' }),
	]);
	if (job.state === 'running' || job.state === 'queued') {
		line.append(el('button', {
			className: 'quiet',
			textContent: t(live ? 'stopAndSave' : 'cancel'),
			testid: 'stop',
			onclick: () => send({ type: 'stop', jobId: job.id, keep: live }),
		}));
	}

	const item = el('li', { testid: 'job' }, [line, bar]);
	item.dataset.state = job.state;
	return item;
};

/** A job that has ended takes one quiet line: what it was, how it went, and what can still be done with it. */
const renderFinished = (job: Job) => {
	const item = el('li', { testid: 'job' }, [
		el('span', { className: 'mark' }),
		el('span', { className: 'title', textContent: job.filename, title: job.filename }),
		el('span', { className: 'status', textContent: jobStatus(job), title: job.error ?? '', testid: 'job-status' }),
	]);
	if (job.state === 'done' && job.downloadId !== undefined) {
		item.append(el('button', { className: 'quiet', textContent: t('showFile'), testid: 'show', onclick: () => send({ type: 'reveal', jobId: job.id }) }));
	}
	item.append(el('button', { className: 'quiet', textContent: t('clear'), testid: 'clear', onclick: () => send({ type: 'dismiss', jobId: job.id }) }));
	item.dataset.state = job.state;
	return item;
};

/** The line about yt-dlp: a way to ask it about this page, or what came of asking. */
const renderProbe = (state: State, tab: chrome.tabs.Tab, found: boolean) => {
	const probe = state.probes[tab.id!];
	const current = probe?.url === tab.url ? probe : undefined;
	probeNote.replaceChildren();
	probeNote.hidden = found || !/^https?:/.test(tab.url ?? '');
	if (probeNote.hidden) {
		return;
	}

	if (current?.status === 'running') {
		probeNote.append(el('span', { textContent: t('probeRunning'), testid: 'probe-status' }));
	} else if (current?.status === 'missing') {
		probeNote.append(el('span', { textContent: t('probeMissing'), testid: 'probe-status' }));
	} else if (current?.status === 'failed') {
		probeNote.append(el('span', { textContent: t('probeFailed', current.message ?? ''), title: current.message ?? '', testid: 'probe-status' }));
	} else {
		probeNote.append(el('button', {
			className: 'quiet',
			textContent: t('probe'),
			testid: 'probe',
			onclick: () => send({ type: 'probe', tabId: tab.id! }),
		}));
	}
};

const render = (state: State, tab: chrome.tabs.Tab) => {
	const tabId = tab.id!;
	// A page item belongs to one address; on sites that navigate without reloading, older ones no longer apply.
	const current = Object.values(state.media[tabId] ?? {}).filter(item => item.kind !== 'page' || item.url === tab.url);
	// Where yt-dlp has answered for a site it knows, its result stands in for the plain files found there.
	const answered = isPageSite(tab.url) && current.some(item => item.kind === 'page');
	const all = answered ? current.filter(item => item.kind !== 'file') : current;
	const onScreen = state.onScreen[tabId] ?? [];
	const playing = onScreen.map(element => element.duration);
	const { shown: media, hidden } = arrange(all, prefs, playing);
	const jobs = Object.values(state.jobs).sort((a, b) => b.startedAt - a.startedAt);

	// The list is only rebuilt when it changes, so progress updates never disturb an open set of options.
	const signature = media.map(item => `${item.key}|${item.thumbnail ? 1 : 0}|${item.duration ?? ''}|${item.tracks ?? ''}|${item.audioUrl ? 1 : 0}|${item.title ?? ''}`).join() + tab.title + prefs.sort + prefs.minDuration + JSON.stringify(onScreen);
	if (signature !== renderedMedia) {
		renderedMedia = signature;
		// When it is known what is on screen, the rest (usually a feed's preloaded videos) waits behind a toggle.
		const current = media.filter(item => isPlaying(item, playing));
		const others = media.filter(item => !current.includes(item));
		const fold = current.length > 0 && others.length > 0;
		const visible = fold && !showOthers ? current : media;
		const markFor = (item: DetectedMedia) => {
			if (!fold || !current.includes(item)) {
				return null;
			}
			const element = onScreen.find(entry => Math.abs(entry.duration - (item.duration ?? -1)) < 0.5);
			return element?.playing ? 'playing' : 'paused';
		};
		mediaList.replaceChildren(...visible.map(item => renderMediaItem(item, tab.title ?? '', markFor(item))));
		if (fold) {
			mediaList.append(el('li', { className: 'fold' }, [el('button', {
				className: 'quiet',
				textContent: showOthers ? t('hideOthers') : t('showOthers', String(others.length)),
				testid: 'others',
				onclick: () => {
					showOthers = !showOthers;
					renderedMedia = '';
					render(state, tab);
				},
			})]));
		}
		if (all.some(item => !item.previewed)) {
			void send({ type: 'preview', tabId });
		}
	}

	// Sorting and filtering only earn their space once there is something to sort through.
	filters.hidden = all.length < 2;
	byId('count').textContent = t('mediaHeading', String(all.length));
	hiddenNote.hidden = hidden === 0;
	hiddenNote.textContent = t('hiddenByFilter', String(hidden));
	renderProbe(state, tab, all.some(item => item.kind === 'page'));

	const running = jobs.filter(job => job.state === 'running' || job.state === 'saving' || job.state === 'queued');
	const finished = jobs.filter(job => !running.includes(job));
	jobList.replaceChildren(...running.map(renderRunning));
	finishedList.replaceChildren(...finished.map(renderFinished));
	tray.hidden = jobs.length === 0;
	byId('clear-finished').hidden = finished.length < 2;

	emptyNote.hidden = all.length > 0 || state.probes[tabId]?.status === 'running';
};

const main = async () => {
	// A tab id in the query string lets the popup be opened as a regular page for a specific tab.
	const requested = Number(new URLSearchParams(location.search).get('tab'));
	const tab = requested
		? await chrome.tabs.get(requested)
		: (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
	if (!tab?.id) {
		return;
	}
	const tabId = tab.id;
	let current = tab;

	try {
		byId('host').textContent = new URL(tab.url ?? '').host;
	} catch {
		// Tabs without a readable URL simply show no host.
	}
	byId('empty-title').textContent = t('emptyTitle');
	byId('empty-text').textContent = t('empty');
	byId('tray-heading').textContent = t('downloadsHeading');
	byId('clear-finished').textContent = t('clearFinished');
	byId('clear-finished').addEventListener('click', () => void send({ type: 'clearFinished' }));

	prefs = { ...DEFAULT_PREFS, ...((await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] as ListPrefs | undefined) };
	sortSelect.replaceChildren(...(['newest', 'longest', 'largest'] as const).map(value => (
		el('option', { value, textContent: t(`sort_${value}`) })
	)));
	durationSelect.replaceChildren(...[0, 60, 300, 1200].map(seconds => (
		el('option', { value: String(seconds), textContent: seconds ? t('longerThan', String(seconds / 60)) : t('anyLength') })
	)));
	sortSelect.value = prefs.sort;
	durationSelect.value = String(prefs.minDuration);

	const stored = await chrome.storage.session.get(STATE_KEY);
	let state: State = { ...emptyState(), ...(stored[STATE_KEY] as State | undefined) };
	const onPrefs = () => {
		prefs = { sort: sortSelect.value as ListPrefs['sort'], minDuration: Number(durationSelect.value) };
		void chrome.storage.local.set({ [PREFS_KEY]: prefs });
		render(state, current);
	};
	sortSelect.addEventListener('change', onPrefs);
	durationSelect.addEventListener('change', onPrefs);

	render(state, current);
	chrome.storage.session.onChanged.addListener(changes => {
		if (changes[STATE_KEY]) {
			state = { ...emptyState(), ...(changes[STATE_KEY].newValue as State | undefined) };
			render(state, current);
		}
	});
	// Titles and addresses change under an open popup on sites that navigate without reloading.
	chrome.tabs.onUpdated.addListener((updatedId, _change, updated) => {
		if (updatedId === tabId) {
			current = updated;
			render(state, current);
		}
	});

	void send({ type: 'scan', tabId });
	setInterval(() => void send({ type: 'scan', tabId }), 1500);
	// On sites yt-dlp is known to handle, the page is checked straight away.
	if (isPageSite(tab.url)) {
		void send({ type: 'probe', tabId });
	}
};

void main();
