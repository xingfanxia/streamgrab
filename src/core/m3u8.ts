import type { Variant } from './types';

export type HlsSummary = {
	isMaster: boolean;
	variants: Variant[];
	/** Sum of EXTINF durations; only meaningful for media playlists. */
	duration?: number;
	live: boolean;
	drm?: string;
	hasVideo: boolean;
	/** URIs of the playlists a master refers to (variants and renditions), exactly as written. */
	childUris: string[];
	subtitles: { label: string; uri: string }[];
};

const DRM_KEYFORMATS: Record<string, string> = {
	'com.apple.streamingkeydelivery': 'FairPlay',
	'com.microsoft.playready': 'PlayReady',
	'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
	'com.widevine': 'Widevine',
};

/** Parses an HLS attribute list such as `BANDWIDTH=1,CODECS="a,b"` into a map. */
export const parseAttributes = (list: string): Record<string, string> => {
	const result: Record<string, string> = {};
	const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
	for (const match of list.matchAll(pattern)) {
		const value = match[2]!;
		result[match[1]!] = value.startsWith('"') ? value.slice(1, -1) : value;
	}
	return result;
};

const detectDrm = (attributes: Record<string, string>): string | undefined => {
	const method = attributes.METHOD;
	if (!method || method === 'NONE') {
		return undefined;
	}

	const keyFormat = (attributes.KEYFORMAT ?? 'identity').toLowerCase();
	for (const [prefix, name] of Object.entries(DRM_KEYFORMATS)) {
		if (keyFormat.startsWith(prefix)) {
			return name;
		}
	}
	if (attributes.URI?.startsWith('skd://')) {
		return 'FairPlay';
	}
	// AES-128 with an identity key is plain transport encryption: the key is published in the playlist.
	if (method === 'AES-128' && keyFormat === 'identity') {
		return undefined;
	}

	return method;
};

/**
 * Extracts what the UI needs from an HLS playlist without resolving any URLs: whether it is a master playlist, its
 * variants, and whether it is live or DRM-protected. Downloading re-parses the playlist with the media engine.
 */
export const summarizeHls = (text: string): HlsSummary | null => {
	if (!text.trimStart().startsWith('#EXTM3U')) {
		return null;
	}

	const lines = text.split(/\r?\n/).map(line => line.trim());
	const variants: Variant[] = [];
	let duration = 0;
	let segmentCount = 0;
	let ended = false;
	let vod = false;
	let drm: string | undefined;
	let anyVideoCodecInfo = false;
	let anyVideo = false;
	let expectVariantUri = false;
	const childUris: string[] = [];
	const subtitles: HlsSummary['subtitles'] = [];
	let textSegments = 0;

	for (const line of lines) {
		if (expectVariantUri && line && !line.startsWith('#')) {
			childUris.push(line);
			expectVariantUri = false;
		} else if (line.startsWith('#EXT-X-MEDIA:')) {
			const attributes = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
			if (attributes.URI) {
				childUris.push(attributes.URI);
				if (attributes.TYPE === 'SUBTITLES') {
					subtitles.push({ label: attributes.NAME || attributes.LANGUAGE || 'subtitles', uri: attributes.URI });
				}
			}
		} else if (line.startsWith('#EXT-X-STREAM-INF:')) {
			expectVariantUri = true;
			const attributes = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
			const [width, height] = (attributes.RESOLUTION ?? '').split('x').map(Number);
			const codecs = attributes.CODECS;
			if (codecs !== undefined || attributes.RESOLUTION !== undefined) {
				anyVideoCodecInfo = true;
				const audioOnly = !attributes.RESOLUTION
					&& codecs !== undefined
					&& codecs.split(',').every(codec => /^(mp4a|ac-3|ec-3|opus|flac)/.test(codec.trim()));
				anyVideo ||= !audioOnly;
			}

			const bitrate = Number(attributes['AVERAGE-BANDWIDTH'] ?? attributes.BANDWIDTH);
			variants.push({
				id: String(variants.length),
				width: width || undefined,
				height: height || undefined,
				bitrate: bitrate || undefined,
				codecs,
			});
		} else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
			drm ??= detectDrm(parseAttributes(line.slice(line.indexOf(':') + 1)));
		} else if (line.startsWith('#EXTINF:')) {
			duration += Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
			segmentCount++;
		} else if (line && !line.startsWith('#') && /\.(vtt|webvtt|srt|ttml)(\?|$)/i.test(line)) {
			textSegments++;
		} else if (line === '#EXT-X-ENDLIST') {
			ended = true;
		} else if (line === '#EXT-X-PLAYLIST-TYPE:VOD') {
			vod = true;
		}
	}

	const isMaster = variants.length > 0;
	// Playlists without segments are not media, and subtitle playlists are offered through their master instead.
	if (!isMaster && (segmentCount === 0 || textSegments === segmentCount)) {
		return null;
	}

	variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));

	return {
		isMaster,
		variants,
		duration: isMaster ? undefined : duration,
		live: !isMaster && !ended && !vod,
		drm,
		hasVideo: isMaster ? (!anyVideoCodecInfo || anyVideo) : true,
		childUris,
		subtitles,
	};
};

/** Lists the segment URIs of a media playlist, in order and as written. */
export const listSegmentUris = (text: string): string[] => (
	text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
);
