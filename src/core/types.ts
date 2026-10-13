/** `page` is a whole page handed to yt-dlp; the others are found by watching the network. */
export type MediaKind = 'file' | 'hls' | 'dash' | 'page';

/** A selectable quality of a detected media item. */
export type Variant = {
	/** Stable identifier within the media item: HLS variant index or DASH representation id. */
	id: string;
	width?: number;
	height?: number;
	bitrate?: number;
	codecs?: string;
	/** The manifest this quality comes from, when an item gathers several manifests of one video. */
	url?: string;
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
	/** Title of this particular video, read from the page around the element that played it. */
	title?: string;
	/** Request headers of the page's own request that are replayed when downloading. */
	replayHeaders: Record<string, string>;
	/** Container extension for direct files, e.g. `mp4`. */
	ext?: string;
	size?: number;
	/** A file a script fetched; dropped when a manifest turns up on the same tab, as it is then a stream fragment. */
	viaScript?: boolean;
	/** Which tracks a file holds, once it has been looked into. */
	tracks?: 'both' | 'video' | 'audio';
	/** For a picture-only file: the separate file that holds its sound, merged in when downloading. */
	audioUrl?: string;
	duration?: number;
	live?: boolean;
	/** Set when the manifest declares a DRM system; such media is listed but not downloadable. */
	drm?: string;
	variants: Variant[];
	hasVideo: boolean;
	/** For an HLS master: absolute URLs of its variant and rendition playlists, which are not listed separately. */
	childUrls?: string[];
	/** Subtitle tracks. `url` is the playlist URL, or for `page` media a `manual:<lang>` / `auto:<lang>` token. */
	subtitles?: { label: string; url: string }[];
	/** Site name reported by yt-dlp for `page` media. */
	site?: string;
	/** Small JPEG data URL, or a remote image URL for `page` media. */
	thumbnail?: string;
	/** Set once a preview has been attempted, successful or not, so it is not retried on every popup open. */
	previewed?: boolean;
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
	/** For a failed job: what each request to the server returned, as text the user can copy out. */
	details?: string;
	/** Id of the browser download that holds the finished file, once it has been handed over. */
	downloadId?: number;
	/** Where yt-dlp saved the file, for jobs it carried out. */
	path?: string;
	/** The text of a finished transcript, kept so it can be copied without opening the file. */
	text?: string;
	startedAt: number;
};

/** What the offscreen engine needs to run one download. */
export type JobRequest = {
	jobId: string;
	kind: Exclude<MediaKind, 'page'> | 'subtitles';
	url: string;
	/** Chosen variant, or null for the best available. */
	variant: Variant | null;
	audioOnly: boolean;
	/** For a `subtitles` job: save readable text instead of the timed subtitle file. */
	transcript?: boolean;
	/** A second file holding the sound, for a `file` whose picture and sound are served separately. */
	audioUrl?: string;
	live: boolean;
	/** File name inside OPFS the result is written to. */
	opfsName: string;
};
