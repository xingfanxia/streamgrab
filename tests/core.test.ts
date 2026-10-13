import { describe, expect, it } from 'vitest';
import { arrange, estimateSize } from '../src/core/arrange';
import { jobsToDrop, mediaToDrop } from '../src/core/bounds';
import { createTurns } from '../src/engine/turns';
import { classify } from '../src/core/classify';
import { summarizeHls } from '../src/core/m3u8';
import { cleanTitle, sanitizeBasename } from '../src/core/naming';
import { findPartner } from '../src/core/pairing';
import type { DetectedMedia, Job } from '../src/core/types';
import { mergeVtt } from '../src/core/vtt';

const response = (url: string, type: string, headers: Record<string, string> = {}, statusCode = 200) => (
	{ url, type, statusCode, headers }
);

describe('classify', () => {
	it('recognises manifests by content type or extension, however they were requested', () => {
		expect(classify(response('https://a/x?id=1', 'xmlhttprequest', { 'content-type': 'application/vnd.apple.mpegurl' }))).toEqual({ kind: 'hls' });
		expect(classify(response('https://a/v/master.m3u8?t=1', 'xmlhttprequest', { 'content-type': 'text/plain' }))).toEqual({ kind: 'hls' });
		expect(classify(response('https://a/v/stream.mpd', 'other'))).toEqual({ kind: 'dash' });
	});

	it('ignores stream segments', () => {
		expect(classify(response('https://a/seg1.ts', 'xmlhttprequest', { 'content-type': 'video/mp2t' }))).toBeNull();
		expect(classify(response('https://a/chunk.m4s', 'media', { 'content-type': 'video/mp4' }))).toBeNull();
	});

	it('lists files the browser plays directly, using the full size of ranged responses', () => {
		const ranged = { 'content-type': 'video/mp4', 'content-range': 'bytes 0-999/52428800', 'content-length': '1000' };
		expect(classify(response('https://a/movie.mp4', 'media', ranged, 206))).toEqual({ kind: 'file', ext: 'mp4', size: 52428800 });
		expect(classify(response('https://a/clip', 'media', { 'content-type': 'video/webm' }))).toEqual({ kind: 'file', ext: 'webm', size: undefined });
	});

	it('lists files fetched by script when they state a size, marking them as possibly part of a stream', () => {
		const sized = { 'content-type': 'video/mp4', 'content-range': 'bytes 0-99999/9000000' };
		expect(classify(response('https://a/v.mp4?sign=1', 'xmlhttprequest', sized, 206))).toEqual({ kind: 'file', ext: 'mp4', size: 9000000, viaScript: true });
		expect(classify(response('https://a/v.mp4', 'xmlhttprequest', { 'content-type': 'video/mp4' }))).toBeNull();
	});

	it('drops tiny files and failed responses', () => {
		expect(classify(response('https://a/blip.mp3', 'media', { 'content-type': 'audio/mpeg', 'content-length': '20000' }))).toBeNull();
		expect(classify(response('https://a/movie.mp4', 'media', { 'content-type': 'video/mp4' }, 403))).toBeNull();
	});
});

describe('summarizeHls', () => {
	it('flags DRM key systems but not plain AES-128', () => {
		const playlist = (key: string) => `#EXTM3U\n${key}\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n`;
		expect(summarizeHls(playlist('#EXT-X-KEY:METHOD=AES-128,URI="k.key"'))!.drm).toBeUndefined();
		expect(summarizeHls(playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"'))!.drm).toBe('FairPlay');
		expect(summarizeHls(playlist('#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"'))!.drm).toBe('Widevine');
	});

	it('treats a playlist without an end marker as live', () => {
		expect(summarizeHls('#EXTM3U\n#EXTINF:4,\na.ts\n')!.live).toBe(true);
		expect(summarizeHls('#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n')!.live).toBe(false);
	});

	it('collects subtitle renditions and rejects subtitle playlists as media', () => {
		const master = summarizeHls('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nv.m3u8\n')!;
		expect(master.subtitles).toEqual([{ label: 'English', uri: 'en.m3u8' }]);
		expect(master.childUris).toEqual(['en.m3u8', 'v.m3u8']);
		expect(summarizeHls('#EXTM3U\n#EXTINF:6,\nen_0.vtt\n#EXT-X-ENDLIST\n')).toBeNull();
	});

	it('rejects text that is not a playlist', () => {
		expect(summarizeHls('<html>not found</html>')).toBeNull();
	});
});

describe('mergeVtt', () => {
	it('keeps one header and drops cues repeated across segment boundaries', () => {
		const header = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n';
		const merged = mergeVtt([
			`${header}00:01.000 --> 00:03.000\nfirst\n\n00:05.000 --> 00:07.000\nshared\n`,
			`${header}00:05.000 --> 00:07.000\nshared\r\n\r\n00:08.000 --> 00:10.000\nlast\n`,
		]);
		expect(merged).toBe('WEBVTT\n\n00:01.000 --> 00:03.000\nfirst\n\n00:05.000 --> 00:07.000\nshared\n\n00:08.000 --> 00:10.000\nlast\n');
	});
});

describe('sanitizeBasename', () => {
	it('removes characters file systems reject and keeps other scripts intact', () => {
		expect(sanitizeBasename('  第1集: a/b\\c? "final" <cut>.  ')).toBe('第1集 a b c final cut');
		expect(sanitizeBasename('///')).toBe('video');
	});
});

describe('arrange', () => {
	const item = (key: string, extra: Partial<DetectedMedia>): DetectedMedia => ({
		key, kind: 'hls', url: `https://a/${key}`, tabId: 1, replayHeaders: {}, variants: [], hasVideo: true, detectedAt: 0, ...extra,
	});
	const media = [
		item('ad', { duration: 15, variants: [{ id: '0', bitrate: 2_000_000 }], detectedAt: 3 }),
		item('film', { duration: 5400, variants: [{ id: '0', bitrate: 4_000_000 }], detectedAt: 1 }),
		item('pending', { detectedAt: 2 }),
		item('clip', { kind: 'file', size: 900_000_000, duration: 120, detectedAt: 4 }),
	];
	const keys = (prefs: Parameters<typeof arrange>[1]) => arrange(media, prefs).shown.map(entry => entry.key);

	it('hides only items known to be too short', () => {
		const result = arrange(media, { sort: 'newest', minDuration: 60 });
		expect(result.shown.map(entry => entry.key)).toEqual(['pending', 'film', 'clip']);
		expect(result.hidden).toBe(1);
	});

	it('puts what is playing first in the default order', () => {
		expect(arrange(media, { sort: 'newest', minDuration: 0 }, [5400.2]).shown[0]!.key).toBe('film');
		expect(arrange(media, { sort: 'longest', minDuration: 0 }, [15]).shown[0]!.key).toBe('film');
	});

	it('orders by duration or size, leaving unknowns last', () => {
		expect(keys({ sort: 'longest', minDuration: 0 })).toEqual(['film', 'clip', 'ad', 'pending']);
		expect(keys({ sort: 'largest', minDuration: 0 })).toEqual(['film', 'clip', 'ad', 'pending']);
	});

	it('estimates stream size from bitrate and duration, and reports file sizes as exact', () => {
		expect(estimateSize(media[1]!)).toEqual({ bytes: 2_700_000_000, exact: false });
		expect(estimateSize(media[3]!)).toEqual({ bytes: 900_000_000, exact: true });
		expect(estimateSize(media[2]!)).toBeNull();
	});
});

describe('cleanTitle', () => {
	it('drops a leading unread counter and nothing else', () => {
		expect(cleanTitle('(4) Home / X')).toBe('Home / X');
		expect(cleanTitle('(99+) Inbox')).toBe('Inbox');
		expect(cleanTitle('Scores (2026)')).toBe('Scores (2026)');
	});
});

describe('site lists', () => {
	it('treats fragment sites as page sites, and keeps network detection on the rest', async () => {
		const { isFragmentSite, isPageSite } = await import('../src/core/sites');
		expect(isFragmentSite('https://www.youtube.com/watch?v=x')).toBe(true);
		expect(isPageSite('https://www.youtube.com/watch?v=x')).toBe(true);
		expect(isFragmentSite('https://www.xiaohongshu.com/explore/1')).toBe(false);
		expect(isPageSite('https://www.xiaohongshu.com/explore/1')).toBe(true);
		expect(isPageSite('https://notyoutube.com.example.org/')).toBe(false);
		expect(isPageSite(undefined)).toBe(false);
	});

	it('turns a feed address with a video overlay into the video address', async () => {
		const { pageUrlForYtDlp } = await import('../src/core/sites');
		expect(pageUrlForYtDlp('https://www.douyin.com/jingxuan?modal_id=7695696443977387273')).toBe('https://www.douyin.com/video/7695696443977387273');
		expect(pageUrlForYtDlp('https://www.douyin.com/video/123')).toBe('https://www.douyin.com/video/123');
		expect(pageUrlForYtDlp('https://example.com/?modal_id=5')).toBe('https://example.com/?modal_id=5');
	});
});

describe('findPartner', () => {
	const file = (key: string, tracks: DetectedMedia['tracks'], duration?: number): DetectedMedia => ({
		key, kind: 'file', url: `https://a/${key}`, tabId: 1, replayHeaders: {}, variants: [], hasVideo: tracks !== 'audio', detectedAt: 0, tracks, duration,
	});

	it('pairs picture and sound of the same running time, in either direction', () => {
		const items = [file('picture', 'video', 424.57), file('sound', 'audio', 424.6), file('short', 'both', 36.5), file('other-sound', 'audio', 36.5)];
		expect(findPartner(items[0]!, items)?.key).toBe('sound');
		expect(findPartner(items[1]!, items)?.key).toBe('picture');
	});

	it('leaves complete files and unmatched tracks alone', () => {
		const items = [file('whole', 'both', 60), file('sound', 'audio', 60), file('picture', 'video', 90), file('unknown', 'video')];
		expect(findPartner(items[0]!, items)).toBeUndefined();
		expect(findPartner(items[1]!, items)).toBeUndefined();
		expect(findPartner(items[3]!, items)).toBeUndefined();
	});
});

describe('createTurns', () => {
	const scenario = (limit: number) => {
		const turns = createTurns(limit);
		const log: string[] = [];
		const job = async (key: string, name: string, ms: number, signal?: AbortSignal) => {
			let end: () => void;
			try {
				end = await turns.take(key, signal);
			} catch {
				log.push(`${name} gave up`);
				return;
			}
			log.push(`${name} start`);
			await new Promise(resolve => setTimeout(resolve, ms));
			log.push(`${name} end`);
			end();
		};
		return { turns, log, job };
	};

	it('runs up to the limit per key at once and the rest in order, with keys independent', async () => {
		const { log, job } = scenario(2);
		await Promise.all([job('a', 'one', 30), job('a', 'two', 30), job('a', 'three', 5), job('b', 'other', 5)]);
		expect(log.slice(0, 3)).toEqual(['one start', 'two start', 'other start']);
		expect(log.indexOf('three start')).toBeGreaterThan(log.indexOf('one end'));
	});

	it('lets a waiting holder give up at once without holding up the line', async () => {
		const { log, job } = scenario(1);
		const cancel = new AbortController();
		const all = Promise.all([job('a', 'one', 30), job('a', 'two', 5, cancel.signal), job('a', 'three', 5)]);
		cancel.abort();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(log).toEqual(['one start', 'two gave up']);
		await all;
		expect(log).toEqual(['one start', 'two gave up', 'one end', 'three start', 'three end']);
	});

	it('starts from a limit learned earlier for a key', () => {
		const turns = createTurns(5, { crowded: 1 });
		expect(turns.limitOf('crowded')).toBe(1);
		expect(turns.limitOf('fresh')).toBe(5);
	});

	it('applies a lowered limit to those still waiting', async () => {
		const { turns, log, job } = scenario(2);
		const all = Promise.all([job('a', 'one', 20), job('a', 'two', 40), job('a', 'three', 5), job('a', 'four', 5)]);
		turns.setLimit('a', 1);
		await all;
		expect(log.indexOf('three start')).toBeGreaterThan(log.indexOf('two end'));
		expect(log.indexOf('four start')).toBeGreaterThan(log.indexOf('three end'));
	});
});

describe('bounds', () => {
	const media = (key: string, detectedAt: number) => ({ key, detectedAt }) as DetectedMedia;
	const job = (id: string, state: Job['state'], startedAt: number) => ({ id, state, startedAt }) as Job;

	it('drops the oldest media beyond the limit, never the one just added', () => {
		const items = [media('new', 1), media('b', 2), media('c', 3), media('d', 4)];
		expect(mediaToDrop(items, 'new', 3)).toEqual(['b']);
		expect(mediaToDrop(items, 'new', 4)).toEqual([]);
	});

	it('drops the oldest finished jobs beyond the limit and leaves unfinished ones alone', () => {
		const jobs = [job('old-running', 'running', 1), job('a', 'done', 2), job('b', 'failed', 3), job('c', 'canceled', 4), job('waiting', 'queued', 5)];
		expect(jobsToDrop(jobs, 2)).toEqual(['a']);
		expect(jobsToDrop(jobs, 3)).toEqual([]);
	});
});

describe('toTranscript', () => {
	it('strips timings and markup and joins a cue broken over lines', async () => {
		const { toTranscript } = await import('../src/core/transcript');
		const vtt = 'WEBVTT\nKind: captions\n\nNOTE not shown\n\n1\n00:00:01.000 --> 00:00:03.000 align:start\n<v Ada>Tom &amp; I <i>left</i>\nat nine.\n\n00:00:03.200 --> 00:00:05.000\n<c.yellow>It was</c> raining.\n';
		expect(toTranscript(vtt)).toBe('Ada: Tom & I left at nine. It was raining.\n');
	});

	it('keeps lines once when captions scroll up a line at a time', async () => {
		const { toTranscript } = await import('../src/core/transcript');
		const srt = [
			'1\n00:00:00,000 --> 00:00:02,000\nall right so here we are',
			'2\n00:00:02,000 --> 00:00:02,010\nall right so here we are',
			'3\n00:00:02,010 --> 00:00:04,000\nall right so here we are\nin front of the elephants',
			'4\n00:00:04,000 --> 00:00:06,000\nin front of the elephants\nthe cool thing about these guys',
		].join('\n\n');
		expect(toTranscript(srt)).toBe('all right so here we are in front of the elephants the cool thing about these guys\n');
	});

	it('starts a paragraph after a pause and keeps a line that is genuinely said again later', async () => {
		const { toTranscript } = await import('../src/core/transcript');
		const cue = (start: number, text: string) => `00:00:${String(start).padStart(2, '0')}.000 --> 00:00:${String(start + 1).padStart(2, '0')}.000\n${text}`;
		const vtt = `WEBVTT\n\n${[cue(0, 'Thank you.'), cue(1, 'First point.'), cue(2, 'Second.'), cue(3, 'Third.'), cue(4, 'Fourth.'), cue(5, 'Fifth.'), cue(10, 'Thank you.')].join('\n\n')}\n`;
		expect(toTranscript(vtt)).toBe('Thank you. First point. Second. Third. Fourth. Fifth.\n\nThank you.\n');
	});

	it('does not put spaces into text written without them', async () => {
		const { toTranscript } = await import('../src/core/transcript');
		expect(toTranscript('WEBVTT\n\n00:01.000 --> 00:02.000\n大家好，\n\n00:02.000 --> 00:03.000\n欢迎回来。\n\n00:03.000 --> 00:04.000\nToday 我们聊 AI\n')).toBe('大家好，欢迎回来。Today 我们聊 AI\n');
	});

	it('gives nothing for a file with no cues', async () => {
		const { toTranscript } = await import('../src/core/transcript');
		expect(toTranscript('WEBVTT\n\n')).toBe('');
	});
});
