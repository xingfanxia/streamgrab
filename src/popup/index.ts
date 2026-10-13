import type { DetectedMedia, Job } from '../core/types';
import { emptyState, STATE_KEY, type State, type UiCommand } from '../shared/messages';

const t = (key: string, substitution?: string) => chrome.i18n.getMessage(key, substitution);
const send = (command: UiCommand) => chrome.runtime.sendMessage(command);

const mediaList = document.querySelector<HTMLUListElement>('#media')!;
const jobList = document.querySelector<HTMLUListElement>('#jobs')!;
const emptyNote = document.querySelector<HTMLParagraphElement>('#empty')!;

/** Variant chosen per media key, kept across re-renders. */
const chosenVariant = new Map<string, string>();
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
	return bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`;
};

const formatDuration = (seconds: number) => {
	const whole = Math.round(seconds);
	const parts = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
	const shown = parts[0] ? parts : parts.slice(1);
	return shown.map((part, i) => (i === 0 ? String(part) : String(part).padStart(2, '0'))).join(':');
};

const kindLabel = (media: DetectedMedia) => {
	if (media.kind === 'hls') {
		return t('kindHls');
	}
	if (media.kind === 'dash') {
		return t('kindDash');
	}
	return t('kindFile', (media.ext ?? 'mp4').toUpperCase());
};

const variantLabel = (variant: DetectedMedia['variants'][number]) => {
	const size = variant.height ? `${variant.height}p` : '';
	const rate = variant.bitrate ? `${(variant.bitrate / 1e6).toFixed(variant.bitrate < 1e6 ? 2 : 1)} Mbps` : '';
	return [size, rate].filter(Boolean).join(', ') || variant.id;
};

const fileNameOf = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop() || url);

const renderMediaItem = (media: DetectedMedia) => {
	const facts = el('div', { className: 'facts' }, [el('span', { className: 'kind', textContent: kindLabel(media) })]);
	if (media.live) {
		facts.append(el('span', { className: 'live', textContent: t('live') }));
	}
	if (media.duration) {
		facts.append(el('span', { textContent: formatDuration(media.duration) }));
	}
	if (media.size) {
		facts.append(el('span', { textContent: formatBytes(media.size) }));
	}
	if (!media.hasVideo) {
		facts.append(el('span', { textContent: t('kindAudio') }));
	}

	const item = el('li', { testid: 'media-item' }, [
		el('div', { className: 'title', textContent: media.pageTitle || fileNameOf(media.url), title: media.url }),
		facts,
	]);
	item.dataset.kind = media.kind;

	if (media.drm) {
		item.append(el('p', { className: 'blocked', textContent: t('blocked', media.drm), testid: 'blocked' }));
		return item;
	}

	const actions = el('div', { className: 'actions' });
	let select: HTMLSelectElement | null = null;
	if (media.variants.length > 1) {
		select = el('select', { testid: 'quality' }, media.variants.map(variant => (
			el('option', { value: variant.id, textContent: variantLabel(variant) })
		)));
		select.value = chosenVariant.get(media.key) ?? media.variants[0]!.id;
		select.addEventListener('change', () => chosenVariant.set(media.key, select!.value));
		actions.append(select);
	}

	const start = (audioOnly: boolean) => send({
		type: 'download',
		tabId: media.tabId,
		key: media.key,
		variantId: select?.value ?? media.variants[0]?.id ?? null,
		audioOnly,
	});
	if (media.hasVideo && media.kind !== 'file') {
		actions.append(el('button', { className: 'quiet', textContent: t('audioOnly'), testid: 'audio-only', onclick: () => start(true) }));
	}
	actions.append(el('button', {
		className: 'primary',
		textContent: t(media.live ? 'record' : 'download'),
		testid: 'download',
		onclick: () => start(false),
	}));

	item.append(actions);

	if (media.subtitles?.length) {
		const subtitles = el('select', { testid: 'subtitles' }, [
			el('option', { value: '', textContent: t('subtitles') }),
			...media.subtitles.map(track => el('option', { value: track.url, textContent: track.label })),
		]);
		subtitles.addEventListener('change', () => {
			if (subtitles.value) {
				void send({ type: 'download', tabId: media.tabId, key: media.key, variantId: null, audioOnly: false, subtitleUrl: subtitles.value });
				subtitles.value = '';
			}
		});
		item.append(el('div', { className: 'actions' }, [subtitles]));
	}
	return item;
};

const jobStatus = (job: Job) => {
	if (job.state === 'failed') {
		return t('stateFailed', job.error ?? '');
	}
	if (job.state === 'running') {
		const label = job.progress === null ? t('stateRecording') : `${t('stateRunning')} ${Math.round(job.progress * 100)}%`;
		return `${label}, ${formatBytes(job.bytes)}`;
	}
	const key = { saving: 'stateSaving', done: 'stateDone', canceled: 'stateCanceled', queued: 'stateRunning' }[job.state];
	return job.state === 'done' ? `${t(key)}, ${formatBytes(job.bytes)}` : t(key);
};

const renderJob = (job: Job) => {
	const bar = el('div', { className: 'segments' });
	if (job.state === 'running' && job.progress === null) {
		bar.classList.add('unknown');
	} else if (job.state === 'done' || job.state === 'saving') {
		bar.classList.add('done');
	} else if (job.state === 'failed' || job.state === 'canceled') {
		bar.classList.add('failed');
	} else {
		bar.style.setProperty('--filled', `${Math.round((job.progress ?? 0) * 100)}%`);
	}

	const status = el('div', { className: 'status' }, [
		el('span', { className: job.state === 'failed' ? 'error' : '', textContent: jobStatus(job), testid: 'job-status' }),
	]);
	if (job.state === 'running') {
		const live = job.progress === null;
		status.append(el('button', {
			className: 'quiet',
			textContent: t(live ? 'stopAndSave' : 'cancel'),
			testid: 'stop',
			onclick: () => send({ type: 'stop', jobId: job.id, keep: live }),
		}));
	} else if (job.state !== 'saving') {
		status.append(el('button', { className: 'quiet', textContent: t('clear'), testid: 'clear', onclick: () => send({ type: 'dismiss', jobId: job.id }) }));
	}

	const item = el('li', { testid: 'job' }, [el('div', { className: 'title', textContent: job.filename }), bar, status]);
	item.dataset.state = job.state;
	return item;
};

const render = (state: State, tabId: number) => {
	const media = Object.values(state.media[tabId] ?? {}).sort((a, b) => (
		Number(b.kind !== 'file') - Number(a.kind !== 'file') || b.detectedAt - a.detectedAt
	));
	const jobs = Object.values(state.jobs).sort((a, b) => b.startedAt - a.startedAt);

	// The media list is only rebuilt when it changes, so progress updates never close an open quality menu.
	const signature = media.map(item => item.key).join();
	if (signature !== renderedMedia) {
		renderedMedia = signature;
		mediaList.replaceChildren(...media.map(renderMediaItem));
	}
	jobList.replaceChildren(...jobs.map(renderJob));

	emptyNote.hidden = media.length > 0 || jobs.length > 0;
	emptyNote.textContent = t('empty');
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

	try {
		document.querySelector('#host')!.textContent = new URL(tab.url ?? '').host;
	} catch {
		// Tabs without a readable URL simply show no host.
	}

	const stored = await chrome.storage.session.get(STATE_KEY);
	render((stored[STATE_KEY] as State | undefined) ?? emptyState(), tabId);
	chrome.storage.session.onChanged.addListener(changes => {
		if (changes[STATE_KEY]) {
			render((changes[STATE_KEY].newValue as State | undefined) ?? emptyState(), tabId);
		}
	});
};

void main();
