import type { DetectedMedia, Variant } from './types';

export type ListPrefs = {
	sort: 'newest' | 'longest' | 'largest';
	/** Items known to be shorter than this many seconds are hidden; 0 shows everything. */
	minDuration: number;
};

/** Whether an item is one of the things playing on the page, judged by running time. */
export const isPlaying = (media: DetectedMedia, playing: number[]): boolean => (
	media.duration !== undefined && playing.some(duration => Math.abs(duration - media.duration!) < 0.5)
);

export const DEFAULT_PREFS: ListPrefs = { sort: 'newest', minDuration: 0 };

/**
 * Size in bytes of a media item at the given quality. Files report theirs; for streams it is estimated from bitrate
 * and duration, and is unknown until both are.
 */
export const estimateSize = (media: DetectedMedia, variant?: Variant): { bytes: number; exact: boolean } | null => {
	if (media.size) {
		return { bytes: media.size, exact: true };
	}
	const bitrate = (variant ?? media.variants[0])?.bitrate;
	if (bitrate && media.duration) {
		return { bytes: Math.round(bitrate * media.duration / 8), exact: false };
	}
	return null;
};

const KIND_ORDER = { page: 0, hls: 1, dash: 1, file: 2 };

/**
 * Applies the user's filter and ordering to a tab's media. An item whose duration is not known yet is never hidden,
 * since it cannot be said to be too short. Items missing the sorted-by value go last. In the default order, what
 * is playing comes first.
 */
export const arrange = (
	media: DetectedMedia[],
	prefs: ListPrefs,
	playing: number[] = [],
): { shown: DetectedMedia[]; hidden: number } => {
	const shown = media.filter(item => (
		prefs.minDuration === 0 || item.live || item.duration === undefined || item.duration >= prefs.minDuration
	));

	// What is on screen leads; a feed preloads its next videos, and those are rarely what the user came for.
	const newest = (a: DetectedMedia, b: DetectedMedia) => (
		Number(isPlaying(b, playing)) - Number(isPlaying(a, playing))
		|| KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
		|| b.detectedAt - a.detectedAt
	);
	const by = (value: (item: DetectedMedia) => number | undefined) => (a: DetectedMedia, b: DetectedMedia) => (
		(value(b) ?? -1) - (value(a) ?? -1) || newest(a, b)
	);
	const order = {
		newest,
		longest: by(item => item.duration),
		largest: by(item => estimateSize(item)?.bytes),
	}[prefs.sort];

	return { shown: [...shown].sort(order), hidden: media.length - shown.length };
};
