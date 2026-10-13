import type { DetectedMedia, Job, JobRequest } from '../core/types';

/** Everything the UI renders, kept in `chrome.storage.session` so it survives service worker restarts. */
export type State = {
	/** Detected media per tab id, keyed by media key. */
	media: Record<string, Record<string, DetectedMedia>>;
	jobs: Record<string, Job>;
};

export const STATE_KEY = 'state';
export const emptyState = (): State => ({ media: {}, jobs: {} });

/** Sent by the popup to the service worker. */
export type UiCommand =
	/** `subtitleUrl` asks for one of the media's subtitle tracks instead of the media itself. */
	| { type: 'download'; tabId: number; key: string; variantId: string | null; audioOnly: boolean; subtitleUrl?: string }
	/** Ends a running job; `keep` saves what was received so far instead of discarding it. */
	| { type: 'stop'; jobId: string; keep: boolean }
	| { type: 'dismiss'; jobId: string }
	| { type: 'forget'; tabId: number; key: string };

/** Sent by the service worker to the offscreen engine. */
export type EngineCommand =
	| { to: 'engine'; type: 'run'; request: JobRequest }
	| { to: 'engine'; type: 'stop'; jobId: string; keep: boolean }
	| { to: 'engine'; type: 'release'; jobId: string };

/** Sent by the offscreen engine to the service worker. */
export type EngineEvent =
	/** Asks for the job's replayed headers to also apply to this host; answered once the rule is in place. */
	| { from: 'engine'; type: 'host'; jobId: string; host: string }
	| { from: 'engine'; type: 'progress'; jobId: string; progress: number | null; bytes: number }
	| { from: 'engine'; type: 'done'; jobId: string; blobUrl: string; bytes: number }
	| { from: 'engine'; type: 'canceled'; jobId: string }
	| { from: 'engine'; type: 'failed'; jobId: string; error: string };

export const isEngineCommand = (message: unknown): message is EngineCommand => (
	typeof message === 'object' && message !== null && (message as { to?: unknown }).to === 'engine'
);

export const isEngineEvent = (message: unknown): message is EngineEvent => (
	typeof message === 'object' && message !== null && (message as { from?: unknown }).from === 'engine'
);
