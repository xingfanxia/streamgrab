import {
	ALL_FORMATS,
	CanvasSink,
	HLS_FORMATS,
	Input,
	MATROSKA,
	MP4,
	ReadableStreamSource,
	UrlSource,
	WEBM,
	type InputVideoTrack,
} from 'mediabunny';
import { summarizeDash } from '../core/mpd';
import type { Preview } from '../shared/messages';
import { partStream } from './fetching';

const THUMBNAIL_WIDTH = 240;

const openInput = async (kind: 'file' | 'hls' | 'dash', url: string, fetchFn: typeof fetch) => {
	if (kind === 'dash') {
		const manifest = await fetchFn(url);
		const summary = summarizeDash(await manifest.text(), manifest.url || url);
		// The smallest representation decodes fastest, and its first few segments are enough for one frame.
		const track = summary?.videos.at(-1);
		if (!track) {
			return null;
		}
		return new Input({
			source: new ReadableStreamSource(partStream(track.parts.slice(0, 4), fetchFn, () => {})),
			formats: [MP4, WEBM, MATROSKA],
		});
	}

	return new Input({
		source: new UrlSource(url, { fetchFn, getRetryDelay: attempts => (attempts < 2 ? 0.5 : null) }),
		formats: kind === 'hls' ? HLS_FORMATS : ALL_FORMATS,
		formatOptions: { hls: { offsetTimestampsByDateTime: false } },
	});
};

const smallest = async (tracks: InputVideoTrack[]) => {
	let best: InputVideoTrack | null = null;
	let bestHeight = Infinity;
	for (const track of tracks) {
		const height = await track.getDisplayHeight();
		if (height < bestHeight) {
			best = track;
			bestHeight = height;
		}
	}
	return best;
};

/**
 * Reads a media item's duration and decodes one frame of it as a thumbnail. The frame is taken a little way in,
 * because the very first frame of a video is often black.
 */
export const makePreview = async (kind: 'file' | 'hls' | 'dash', url: string, fetchFn: typeof fetch): Promise<Preview> => {
	const input = await openInput(kind, url, fetchFn);
	if (!input) {
		return {};
	}

	try {
		const preview: Preview = {};
		const video = await smallest(await input.getVideoTracks());
		const audio = await input.getPrimaryAudioTrack();
		if (video || audio) {
			preview.tracks = video && audio ? 'both' : video ? 'video' : 'audio';
		}
		const live = video ? await video.isLive() : false;
		if (kind !== 'dash' && !live) {
			const duration = await input.computeDuration();
			if (Number.isFinite(duration) && duration > 0) {
				preview.duration = duration;
			}
		}

		if (video && await video.canDecode()) {
			const start = await video.getFirstTimestamp();
			const offset = kind === 'dash' || live ? 0 : Math.min((preview.duration ?? 0) * 0.1, 5);
			const sink = new CanvasSink(video, { width: THUMBNAIL_WIDTH });
			const frame = await sink.getCanvas(start + offset) ?? await sink.getCanvas(start);
			if (frame) {
				const canvas = frame.canvas as OffscreenCanvas | HTMLCanvasElement;
				const blob = 'convertToBlob' in canvas
					? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
					: await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.7));
				if (blob) {
					preview.thumbnail = await new Promise<string>(resolve => {
						const reader = new FileReader();
						reader.onload = () => resolve(reader.result as string);
						reader.readAsDataURL(blob);
					});
				}
			}
		}
		return preview;
	} finally {
		input.dispose();
	}
};
