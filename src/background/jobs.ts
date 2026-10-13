import { cleanTitle, sanitizeBasename } from '../core/naming';
import type { DetectedMedia, Job, JobRequest } from '../core/types';
import type { EngineCommand, EngineEvent, UiCommand } from '../shared/messages';
import { newRuleId, removeHeaderRule, setHeaderRule } from './headers';
import { loadState, mutate } from './state';
import { startPageDownload, stopPageDownload } from './ytdlp';

/** Per running job: the header rule, the headers it replays and the hosts it covers so far. */
type JobRule = { ruleId: number; headers: Record<string, string>; hosts: string[] };

const RULES_KEY = 'jobRules';
const DOWNLOADS_KEY = 'jobDownloads';

const readMap = async <T>(key: string): Promise<Record<string, T>> => (
	((await chrome.storage.session.get(key))[key] as Record<string, T> | undefined) ?? {}
);
const writeMap = (key: string, value: Record<string, unknown>) => chrome.storage.session.set({ [key]: value });

/**
 * Runs a read-change-write of the rule map on its own turn. Several downloads and previews update the map at the
 * same time, and without taking turns one update would overwrite another.
 */
let rulesTurn: Promise<unknown> = Promise.resolve();
const withRules = <T>(change: (rules: Record<string, JobRule>) => Promise<T> | T): Promise<T> => {
	const turn = rulesTurn.then(async () => {
		const rules = await readMap<JobRule>(RULES_KEY);
		const result = await change(rules);
		await writeMap(RULES_KEY, rules);
		return result;
	});
	rulesTurn = turn.catch(() => {});
	return turn;
};

let engineReady: Promise<void> | null = null;
/** Work other than jobs (previews) that needs the engine document kept open. */
let engineHolds = 0;

export const ensureEngine = () => {
	engineReady ??= (async () => {
		if (!await chrome.offscreen.hasDocument()) {
			await chrome.offscreen.createDocument({
				url: 'offscreen.html',
				reasons: ['BLOBS'],
				justification: 'Assembles downloaded media into a file and hands it to the downloads API as a blob URL.',
			});
		}
	})().finally(() => {
		engineReady = null;
	});
	return engineReady;
};

export const sendToEngine = (command: EngineCommand) => chrome.runtime.sendMessage(command);

/** Keeps the engine document open until the returned function is called. */
export const holdEngine = () => {
	engineHolds++;
	return async () => {
		engineHolds--;
		await closeEngineIfIdle();
	};
};

const isActive = (job: Job) => job.state === 'queued' || job.state === 'running' || job.state === 'saving';

const closeEngineIfIdle = async () => {
	const state = await loadState();
	if (engineHolds === 0 && !Object.values(state.jobs).some(isActive) && await chrome.offscreen.hasDocument()) {
		await chrome.offscreen.closeDocument().catch(() => {});
	}
};

/** Starts replaying `headers` for the requests the engine makes under `id`; hosts are added as it meets them. */
export const openRule = async (id: string, headers: Record<string, string>) => {
	await withRules(rules => {
		rules[id] = { ruleId: newRuleId(), headers, hosts: [] };
	});
};

export const dropRule = (jobId: string) => withRules(async rules => {
	const rule = rules[jobId];
	if (rule) {
		await removeHeaderRule(rule.ruleId);
		delete rules[jobId];
	}
});

const finish = async (jobId: string, patch: Partial<Job>) => {
	await mutate(state => {
		const job = state.jobs[jobId];
		if (job) {
			Object.assign(job, patch);
		}
	});
	await dropRule(jobId);
};

const extensionFor = (media: DetectedMedia, audioOnly: boolean) => {
	if (media.kind === 'file' && media.audioUrl) {
		return 'mp4';
	}
	if (media.kind === 'file') {
		return media.ext ?? 'mp4';
	}
	return audioOnly || !media.hasVideo ? 'm4a' : 'mp4';
};

export const startDownload = async (command: Extract<UiCommand, { type: 'download' }>) => {
	const state = await loadState();
	const media = state.media[command.tabId]?.[command.key];
	if (!media || media.drm) {
		return;
	}

	const tab = await chrome.tabs.get(command.tabId).catch(() => null);
	if (media.kind === 'page') {
		await startPageDownload(media, command);
		return;
	}
	const kind = media.kind;
	const title = sanitizeBasename(media.title || cleanTitle(tab?.title || media.pageTitle || '') || new URL(media.url).hostname);
	const audioOnly = command.audioOnly || !media.hasVideo;
	const subtitle = media.subtitles?.find(track => track.url === command.subtitleUrl);
	const ext = subtitle ? 'vtt' : extensionFor(media, audioOnly);
	const basename = subtitle ? `${title}.${sanitizeBasename(subtitle.label)}` : title;
	const jobId = crypto.randomUUID();

	await openRule(jobId, media.replayHeaders);

	await mutate(current => {
		current.jobs[jobId] = {
			id: jobId,
			mediaKey: media.key,
			tabId: media.tabId,
			title,
			filename: `${basename}.${ext}`,
			state: 'queued',
			progress: media.live && !subtitle ? null : 0,
			bytes: 0,
			startedAt: Date.now(),
		};
	});

	const variant = media.variants.find(entry => entry.id === command.variantId) ?? media.variants[0] ?? null;
	const request: JobRequest = {
		jobId,
		kind: subtitle ? 'subtitles' : kind,
		// An item gathered from several manifests downloads from the one that holds the chosen quality.
		url: subtitle?.url ?? variant?.url ?? media.url,
		variant,
		audioOnly,
		audioUrl: subtitle ? undefined : media.audioUrl,
		live: media.live ?? false,
		opfsName: `${jobId}.${ext}`,
	};
	await ensureEngine();
	await sendToEngine({ to: 'engine', type: 'run', request });
};

export const stopDownload = (jobId: string, keep: boolean) => (
	stopPageDownload(jobId) || sendToEngine({ to: 'engine', type: 'stop', jobId, keep })
);

export const dismissJob = (jobId: string) => mutate(state => {
	delete state.jobs[jobId];
});

export const revealJob = async (jobId: string) => {
	const downloadId = (await loadState()).jobs[jobId]?.downloadId;
	if (downloadId !== undefined) {
		chrome.downloads.show(downloadId);
	}
};

export const clearFinished = () => mutate(state => {
	for (const job of Object.values(state.jobs)) {
		if (!isActive(job)) {
			delete state.jobs[job.id];
		}
	}
});

/** Handles an engine event; the returned promise settles when the engine may proceed. */
export const onEngineEvent = async (event: EngineEvent) => {
	if (event.type === 'host') {
		await withRules(async rules => {
			const rule = rules[event.jobId];
			if (rule && !rule.hosts.includes(event.host)) {
				rule.hosts.push(event.host);
				await setHeaderRule(rule.ruleId, rule.headers, rule.hosts);
			}
		});
		return;
	}

	if (event.type === 'started') {
		await mutate(state => {
			const job = state.jobs[event.jobId];
			if (job?.state === 'queued') {
				job.state = 'running';
			}
		});
		return;
	}

	if (event.type === 'progress') {
		await mutate(state => {
			const job = state.jobs[event.jobId];
			if (job?.state === 'running') {
				job.progress = event.progress;
				job.bytes = event.bytes;
			}
		});
		return;
	}

	if (event.type === 'done') {
		const state = await loadState();
		const job = state.jobs[event.jobId];
		if (!job) {
			await sendToEngine({ to: 'engine', type: 'release', jobId: event.jobId });
			return;
		}
		await finish(event.jobId, { state: 'saving', bytes: event.bytes, progress: 1 });
		const downloadId = await chrome.downloads.download({
			url: event.blobUrl,
			filename: job.filename,
			conflictAction: 'uniquify',
		});
		await mutate(current => {
			const saved = current.jobs[event.jobId];
			if (saved) {
				saved.downloadId = downloadId;
			}
		});
		const downloads = await readMap<string>(DOWNLOADS_KEY);
		downloads[downloadId] = event.jobId;
		await writeMap(DOWNLOADS_KEY, downloads);
		return;
	}

	await finish(event.jobId, event.type === 'canceled'
		? { state: 'canceled' }
		: { state: 'failed', error: event.error, details: `streamgrab ${chrome.runtime.getManifest().version}\n${event.details}` });
	await closeEngineIfIdle();
};

/** Called when the browser finishes (or gives up on) copying a result into the downloads folder. */
export const onBrowserDownloadChanged = async (delta: chrome.downloads.DownloadDelta) => {
	const outcome = delta.state?.current;
	if (outcome !== 'complete' && outcome !== 'interrupted') {
		return;
	}

	const downloads = await readMap<string>(DOWNLOADS_KEY);
	const jobId = downloads[delta.id];
	if (!jobId) {
		return;
	}
	delete downloads[delta.id];
	await writeMap(DOWNLOADS_KEY, downloads);

	await finish(jobId, outcome === 'complete' ? { state: 'done' } : { state: 'failed', error: delta.error?.current ?? 'interrupted' });
	await sendToEngine({ to: 'engine', type: 'release', jobId });
	await closeEngineIfIdle();
};

/** Jobs cannot outlive the engine document, so anything still marked active without one is reported as failed. */
export const reconcileJobs = async () => {
	if (await chrome.offscreen.hasDocument()) {
		return;
	}
	await mutate(state => {
		for (const job of Object.values(state.jobs)) {
			if (isActive(job)) {
				job.state = 'failed';
				job.error = 'interrupted';
			}
		}
	});
	await withRules(rules => {
		for (const id of Object.keys(rules)) {
			delete rules[id];
		}
	});
	const root = await navigator.storage.getDirectory();
	for await (const name of (root as unknown as { keys: () => AsyncIterable<string> }).keys()) {
		await root.removeEntry(name).catch(() => {});
	}
};
