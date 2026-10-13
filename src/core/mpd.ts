import { parse } from 'mpd-parser';
import type { Variant } from './types';

/** A byte span to fetch: a whole resource, or a range of one. */
export type Part = {
	url: string;
	range?: { offset: number; length: number };
};

export type DashTrack = Variant & {
	language?: string;
	/** Init segment followed by all media segments, in order. Concatenated they form one fragmented MP4/WebM. */
	parts: Part[];
};

export type DashSummary = {
	videos: DashTrack[];
	audios: DashTrack[];
	duration?: number;
	live: boolean;
	drm?: string;
};

const DRM_SYSTEMS: Record<string, string> = {
	'com.widevine.alpha': 'Widevine',
	'com.microsoft.playready': 'PlayReady',
	'com.apple.fps.1_0': 'FairPlay',
	'org.w3.clearkey': 'ClearKey',
};

type ParsedSegment = {
	resolvedUri: string;
	byterange?: { offset: number; length: number };
	map?: { resolvedUri: string; byterange?: { offset: number; length: number } };
};

type ParsedPlaylist = {
	attributes?: {
		NAME?: string;
		BANDWIDTH?: number;
		CODECS?: string;
		RESOLUTION?: { width: number; height: number };
	};
	resolvedUri?: string;
	segments?: ParsedSegment[];
	sidx?: { resolvedUri: string };
	contentProtection?: Record<string, unknown>;
};

const toPart = (uri: string, byterange?: { offset: number; length: number }): Part => (
	byterange ? { url: uri, range: { offset: Number(byterange.offset), length: Number(byterange.length) } } : { url: uri }
);

const samePart = (a: Part, b: Part) => (
	a.url === b.url && a.range?.offset === b.range?.offset && a.range?.length === b.range?.length
);

const toParts = (playlist: ParsedPlaylist): Part[] => {
	const segments = playlist.segments ?? [];
	if (segments.length === 0) {
		// SegmentBase: the representation is a single self-contained fragmented file.
		const whole = playlist.sidx?.resolvedUri ?? playlist.resolvedUri;
		return whole ? [{ url: whole }] : [];
	}

	const parts: Part[] = [];
	let lastInit: Part | null = null;
	for (const segment of segments) {
		if (segment.map) {
			const init = toPart(segment.map.resolvedUri, segment.map.byterange);
			if (!lastInit || !samePart(lastInit, init)) {
				parts.push(init);
				lastInit = init;
			}
		}
		parts.push(toPart(segment.resolvedUri, segment.byterange));
	}
	return parts;
};

const toTrack = (playlist: ParsedPlaylist, index: number, language?: string): DashTrack => ({
	id: playlist.attributes?.NAME ?? String(index),
	width: playlist.attributes?.RESOLUTION?.width,
	height: playlist.attributes?.RESOLUTION?.height,
	bitrate: playlist.attributes?.BANDWIDTH,
	codecs: playlist.attributes?.CODECS,
	language,
	parts: toParts(playlist),
});

const drmOf = (playlists: ParsedPlaylist[]): string | undefined => {
	for (const playlist of playlists) {
		const systems = Object.keys(playlist.contentProtection ?? {});
		if (systems.length > 0) {
			return DRM_SYSTEMS[systems.find(system => system in DRM_SYSTEMS) ?? ''] ?? 'encrypted';
		}
	}
	return undefined;
};

/** Expands a DASH manifest into flat, ordered fetch lists per representation. */
export const summarizeDash = (xml: string, manifestUrl: string): DashSummary | null => {
	let manifest: ReturnType<typeof parse>;
	try {
		manifest = parse(xml, { manifestUri: manifestUrl });
	} catch {
		return null;
	}

	const videoPlaylists = (manifest.playlists ?? []) as ParsedPlaylist[];
	const audioPlaylists: { playlist: ParsedPlaylist; language?: string }[] = [];
	const audioGroups = (manifest.mediaGroups?.AUDIO ?? {}) as Record<
		string,
		Record<string, { language?: string; playlists?: ParsedPlaylist[] }>
	>;
	for (const group of Object.values(audioGroups)) {
		for (const rendition of Object.values(group)) {
			for (const playlist of rendition.playlists ?? []) {
				audioPlaylists.push({ playlist, language: rendition.language || undefined });
			}
		}
	}

	const byQuality = (a: DashTrack, b: DashTrack) => (
		(b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0)
	);
	const videos = videoPlaylists.map((playlist, i) => toTrack(playlist, i)).filter(track => track.parts.length > 0);
	const audios = audioPlaylists
		.map(({ playlist, language }, i) => toTrack(playlist, i, language))
		.filter(track => track.parts.length > 0);
	if (videos.length === 0 && audios.length === 0) {
		return null;
	}

	return {
		videos: videos.sort(byQuality),
		audios: audios.sort(byQuality),
		duration: typeof manifest.duration === 'number' && manifest.duration > 0 ? manifest.duration : undefined,
		live: /type\s*=\s*["']dynamic["']/.test(xml.slice(0, 2000)),
		drm: drmOf([...videoPlaylists, ...audioPlaylists.map(entry => entry.playlist)]),
	};
};
