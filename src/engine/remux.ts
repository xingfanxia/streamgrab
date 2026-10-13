import {
	ALL_FORMATS,
	Conversion,
	HLS_FORMATS,
	Input,
	MATROSKA,
	MP4,
	Mp4OutputFormat,
	Output,
	ReadableStreamSource,
	UrlSource,
	WEBM,
	type InputAudioTrack,
	type InputVideoTrack,
	type Target,
} from 'mediabunny';
import type { DashTrack } from '../core/mpd';
import { partStream } from './fetching';

export type EngineHooks = {
	/** Fetch used for every network request, so the caller controls headers, credentials and accounting. */
	fetchFn: typeof fetch;
	/** Called with 0..1, or null when the total is unknown. */
	onProgress: (fraction: number | null) => void;
	/** Aborting stops the transfer and finalizes the file with whatever was received so far. */
	stopSignal: AbortSignal;
};

export type HlsRequest = {
	url: string;
	/** Preferred variant height; the best variant is used when null or unmatched. */
	height: number | null;
	audioOnly: boolean;
	live: boolean;
};

type Selection = {
	input: Input;
	video: InputVideoTrack | null;
	audio: InputAudioTrack | null;
};

/**
 * Copies the selected tracks of all inputs into a single MP4 without re-encoding. Conversions are composable so the
 * output stays ours to finalize, which is what lets a stopped or live download still end up as a playable file.
 */
const remux = async (selections: Selection[], target: Target, hooks: EngineHooks, reportProgress: boolean) => {
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });

	try {
		const conversions: Conversion[] = [];
		for (const { input, video, audio } of selections) {
			conversions.push(await Conversion.init({
				input,
				output,
				composable: true,
				tracks: 'all',
				showWarnings: false,
				video: track => (track.id === video?.id ? {} : { discard: true }),
				audio: track => (track.id === audio?.id ? {} : { discard: true }),
			}));
		}

		if (conversions.every(conversion => conversion.utilizedTracks.length === 0)) {
			const reasons = conversions.flatMap(conversion => conversion.discardedTracks.map(entry => entry.reason));
			throw new Error(`No track could be copied into MP4 (${[...new Set(reasons)].join(', ') || 'no tracks found'})`);
		}

		if (reportProgress) {
			conversions[0]!.onProgress = fraction => hooks.onProgress(fraction);
		}

		await output.start();
		await Promise.all(conversions.map(conversion => conversion.execute({ pauseSignal: hooks.stopSignal })));
		await output.finalize();
	} catch (error) {
		if (output.state !== 'finalized' && output.state !== 'canceled') {
			await output.cancel().catch(() => {});
		}
		throw error;
	}
};

const pickVideo = async (tracks: InputVideoTrack[], height: number | null) => {
	if (height !== null) {
		for (const track of tracks) {
			if (await track.getDisplayHeight() === height) {
				return track;
			}
		}
	}

	let best: InputVideoTrack | null = null;
	let bestHeight = -1;
	for (const track of tracks) {
		const trackHeight = await track.getDisplayHeight();
		if (trackHeight > bestHeight) {
			best = track;
			bestHeight = trackHeight;
		}
	}
	return best;
};

export const downloadHls = async (request: HlsRequest, target: Target, hooks: EngineHooks) => {
	const input = new Input({
		source: new UrlSource(request.url, {
			fetchFn: hooks.fetchFn,
			getRetryDelay: attempts => (attempts < 5 ? 0.5 * (attempts + 1) : null),
		}),
		formats: HLS_FORMATS,
		formatOptions: { hls: { offsetTimestampsByDateTime: false } },
	});

	try {
		const video = request.audioOnly ? null : await pickVideo(await input.getVideoTracks(), request.height);
		const audio = video
			? (await video.getPairableAudioTracks())[0] ?? null
			: await input.getPrimaryAudioTrack();

		await remux([{ input, video, audio }], target, hooks, !request.live);
	} finally {
		input.dispose();
	}
};

/** Merges a picture-only file and a sound-only file into one MP4. */
export const downloadPair = async (videoUrl: string, audioUrl: string, target: Target, hooks: EngineHooks) => {
	const open = (url: string) => new Input({
		source: new UrlSource(url, { fetchFn: hooks.fetchFn, getRetryDelay: attempts => (attempts < 5 ? 0.5 * (attempts + 1) : null) }),
		formats: ALL_FORMATS,
	});
	const inputs = [open(videoUrl), open(audioUrl)];

	try {
		await remux([
			{ input: inputs[0]!, video: await inputs[0]!.getPrimaryVideoTrack(), audio: null },
			{ input: inputs[1]!, video: null, audio: await inputs[1]!.getPrimaryAudioTrack() },
		], target, hooks, true);
	} finally {
		for (const input of inputs) {
			input.dispose();
		}
	}
};

export const downloadDash = async (
	video: DashTrack | null,
	audio: DashTrack | null,
	target: Target,
	hooks: EngineHooks,
) => {
	const tracks = [video, audio].filter(track => track !== null);
	const total = tracks.reduce((sum, track) => sum + track.parts.length, 0);
	let done = 0;

	const inputs = tracks.map(track => new Input({
		source: new ReadableStreamSource(partStream(track.parts, hooks.fetchFn, () => hooks.onProgress(++done / total))),
		formats: [MP4, WEBM, MATROSKA],
	}));

	try {
		const selections: Selection[] = [];
		for (const input of inputs) {
			selections.push({
				input,
				video: await input.getPrimaryVideoTrack(),
				audio: await input.getPrimaryAudioTrack(),
			});
		}

		await remux(selections, target, hooks, false);
	} finally {
		for (const input of inputs) {
			input.dispose();
		}
	}
};
