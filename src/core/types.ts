export type MediaKind = 'file' | 'hls' | 'dash';

/** A selectable quality of a detected media item. */
export type Variant = {
	/** Stable identifier within the media item: HLS variant index or DASH representation id. */
	id: string;
	width?: number;
	height?: number;
	bitrate?: number;
	codecs?: string;
};

/** One thing the user can download, as detected on a tab. */
export type DetectedMedia = {
	/** Hash of the defining URL (and manifest body for playlists); used for per-tab de-duplication. */
	key: string;
	kind: MediaKind;
	url: string;
	tabId: number;
	pageUrl?: string;
	pageTitle?: string;
	/** Request headers of the page's own request that are replayed when downloading. */
	replayHeaders: Record<string, string>;
	/** Container extension for direct files, e.g. `mp4`. */
	ext?: string;
	size?: number;
	duration?: number;
	live?: boolean;
	/** Set when the manifest declares a DRM system; such media is listed but not downloadable. */
	drm?: string;
	variants: Variant[];
	hasVideo: boolean;
	/** For an HLS master: absolute URLs of its variant and rendition playlists, which are not listed separately. */
	childUrls?: string[];
	subtitles?: { label: string; url: string }[];
	detectedAt: number;
};

export type JobState = 'queued' | 'running' | 'saving' | 'done' | 'failed' | 'canceled';

export type Job = {
	id: string;
	mediaKey: string;
	tabId: number;
	title: string;
	filename: string;
	state: JobState;
	/** 0..1, or null when the total is unknown (live streams). */
	progress: number | null;
	bytes: number;
	error?: string;
	startedAt: number;
};

/** What the offscreen engine needs to run one download. */
export type JobRequest = {
	jobId: string;
	kind: MediaKind | 'subtitles';
	url: string;
	/** Chosen variant, or null for the best available. */
	variant: Variant | null;
	audioOnly: boolean;
	live: boolean;
	/** File name inside OPFS the result is written to. */
	opfsName: string;
};
