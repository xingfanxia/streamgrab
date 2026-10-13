import type { DetectedMedia, Job } from './types';

/**
 * Everything the popup shows lives in session storage, which holds about ten megabytes. A feed that never reloads
 * keeps loading videos for as long as it is scrolled, so what is kept per tab has to be bounded.
 */
export const MAX_MEDIA_PER_TAB = 40;
export const MAX_FINISHED_JOBS = 30;

/** Keys of the oldest items to drop so a tab keeps at most the limit; `keep` is never dropped. */
export const mediaToDrop = (items: DetectedMedia[], keep: string, limit = MAX_MEDIA_PER_TAB): string[] => (
	items
		.filter(item => item.key !== keep)
		.sort((a, b) => a.detectedAt - b.detectedAt)
		.slice(0, Math.max(0, items.length - limit))
		.map(item => item.key)
);

/** Ids of the oldest finished jobs to drop so at most the limit remain; jobs still under way are never dropped. */
export const jobsToDrop = (jobs: Job[], limit = MAX_FINISHED_JOBS): string[] => {
	const finished = jobs.filter(job => job.state === 'done' || job.state === 'failed' || job.state === 'canceled');
	return finished
		.sort((a, b) => a.startedAt - b.startedAt)
		.slice(0, Math.max(0, finished.length - limit))
		.map(job => job.id);
};
