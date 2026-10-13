import type { MediaKind } from './types';

export type ResponseInfo = {
	url: string;
	/** webRequest resource type. */
	type: string;
	statusCode: number;
	/** Response headers with lower-cased names. */
	headers: Record<string, string>;
};

export type Classification = {
	kind: MediaKind;
	ext?: string;
	size?: number;
};

const SEGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'm2ts', 'm4f', 'cmfv', 'cmfa', 'cmft']);
const FILE_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'flv', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac']);
const TYPE_EXTENSIONS: Record<string, string> = {
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'video/x-matroska': 'mkv',
	'video/x-flv': 'flv',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/aac': 'aac',
	'audio/ogg': 'ogg',
	'audio/webm': 'webm',
	'audio/wav': 'wav',
	'audio/flac': 'flac',
};

/** Smallest direct file worth listing; anything below is almost always a UI sound, preview or ad stub. */
export const MIN_FILE_SIZE = 500_000;

export const extensionOf = (url: string): string | undefined => {
	try {
		const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
		return match?.[1]?.toLowerCase();
	} catch {
		return undefined;
	}
};

const totalSize = (headers: Record<string, string>): number | undefined => {
	const fromRange = /\/(\d+)\s*$/.exec(headers['content-range'] ?? '');
	const size = Number(fromRange?.[1] ?? headers['content-length']);
	return Number.isFinite(size) && size > 0 ? size : undefined;
};

/**
 * Decides whether a network response is something worth offering for download. Manifests are recognised wherever they
 * appear; plain files only count when the browser loaded them as media or a document, because media files fetched by
 * script are almost always chunks of a stream whose manifest is detected separately.
 */
export const classify = (response: ResponseInfo): Classification | null => {
	if (response.statusCode < 200 || response.statusCode >= 300) {
		return null;
	}

	const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
	const ext = extensionOf(response.url);

	if (contentType.includes('mpegurl') || ext === 'm3u8') {
		return { kind: 'hls' };
	}
	if (contentType.includes('dash+xml') || ext === 'mpd') {
		return { kind: 'dash' };
	}

	if ((ext && SEGMENT_EXTENSIONS.has(ext)) || contentType === 'video/mp2t' || contentType === 'video/iso.segment') {
		return null;
	}
	if (response.type === 'xmlhttprequest') {
		return null;
	}

	const typeExt = TYPE_EXTENSIONS[contentType];
	const isMediaType = contentType.startsWith('video/') || contentType.startsWith('audio/');
	const isMediaExt = ext !== undefined && FILE_EXTENSIONS.has(ext);
	if (!isMediaType && !(isMediaExt && (response.type === 'media' || contentType === 'application/octet-stream'))) {
		return null;
	}

	const size = totalSize(response.headers);
	if (size !== undefined && size < MIN_FILE_SIZE) {
		return null;
	}

	return { kind: 'file', ext: isMediaExt ? ext : typeExt ?? 'mp4', size };
};
