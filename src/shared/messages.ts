import type { DetectedMedia, Job, JobRequest } from '../core/types';

/** Everything the UI renders, kept in `chrome.storage.session` so it survives service worker restarts. */
export type State = {
	/** Detected media per tab id, keyed by media key. */
	media: Record<string, Record<string, DetectedMedia>>;
	jobs: Record<string, Job>;
	/** Outcome of asking yt-dlp about a tab's page, per tab id. */
	probes: Record<string, Probe>;
	/**
	 * The media elements in view on each tab when it was last looked at, by running time. An element counts when
	 * it is visible and has been started, whether or not it is paused right now.
	 */
	onScreen: Record<string, { duration: number; playing: boolean }[]>;
};

export type Probe = {
	url: string;
	/** `missing` means the yt-dlp bridge is not installed. */
	status: 'running' | 'found' | 'failed' | 'missing';
	message?: string;
};

export const STATE_KEY = 'state';
export const emptyState = (): State => ({ media: {}, jobs: {}, probes: {}, onScreen: {} });

/** Sent by the popup to the service worker. */
export type UiCommand =
	/** `subtitleUrl` asks for one of the media's subtitle tracks instead of the media itself. */
	| { type: 'download'; tabId: number; key: string; variantId: string | null; audioOnly: boolean; subtitleUrl?: string }
	/** Ends a running job; `keep` saves what was received so far instead of discarding it. */
	| { type: 'stop'; jobId: string; keep: boolean }
	| { type: 'dismiss'; jobId: string }
	/** Removes every job that is no longer running from the list. */
	| { type: 'clearFinished' }
	/** Shows a finished job's file in the system file manager. */
	| { type: 'reveal'; jobId: string }
	| { type: 'forget'; tabId: number; key: string }
	/** Asks yt-dlp what it can get from the tab's page. */
	| { type: 'probe'; tabId: number }
	/** Asks for thumbnails and durations of the tab's media that do not have them yet. */
	| { type: 'preview'; tabId: number }
	/** Looks through the page itself for media elements, in addition to what was seen on the network. */
	| { type: 'scan'; tabId: number };

/** Sent by the service worker to the offscreen engine. */
export type EngineCommand =
	| { to: 'engine'; type: 'run'; request: JobRequest }
	| { to: 'engine'; type: 'stop'; jobId: string; keep: boolean }
	| { to: 'engine'; type: 'release'; jobId: string }
	/** Answered with a `Preview`. `id` scopes the header rule exactly as a job id does. */
	| { to: 'engine'; type: 'preview'; id: string; kind: 'file' | 'hls' | 'dash'; url: string };

export type Preview = {
	thumbnail?: string;
	duration?: number;
	tracks?: 'both' | 'video' | 'audio';
	/** Picture height of the stream that was looked at. */
	height?: number;
};

/** Sent by the offscreen engine to the service worker. */
export type EngineEvent =
	/** Asks for the job's replayed headers to also apply to this host; answered once the rule is in place. */
	| { from: 'engine'; type: 'host'; jobId: string; host: string }
	/** The job has reached the front of its server's queue and begun transferring. */
	| { from: 'engine'; type: 'started'; jobId: string }
	/** The job has gone back to waiting for a turn and will start over. */
	| { from: 'engine'; type: 'waiting'; jobId: string }
	| { from: 'engine'; type: 'progress'; jobId: string; progress: number | null; bytes: number }
	| { from: 'engine'; type: 'done'; jobId: string; blobUrl: string; bytes: number }
	| { from: 'engine'; type: 'canceled'; jobId: string }
	| { from: 'engine'; type: 'failed'; jobId: string; error: string; details: string };

export const isEngineCommand = (message: unknown): message is EngineCommand => (
	typeof message === 'object' && message !== null && (message as { to?: unknown }).to === 'engine'
);

export const isEngineEvent = (message: unknown): message is EngineEvent => (
	typeof message === 'object' && message !== null && (message as { from?: unknown }).from === 'engine'
);
