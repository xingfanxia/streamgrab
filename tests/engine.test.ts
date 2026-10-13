import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { BufferTarget } from 'mediabunny';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { summarizeHls } from '../src/core/m3u8';
import { summarizeDash } from '../src/core/mpd';
import { downloadFile } from '../src/engine/file';
import { downloadDash, downloadHls, downloadPair, type EngineHooks } from '../src/engine/remux';
import { serveFixtures, type FixtureServer } from './serve';

const FIXTURES = join(import.meta.dirname, '../scratch/data/fixtures');
const OUT = join(import.meta.dirname, '../scratch/data/engine-out');

type Probe = {
	format: { duration: string };
	streams: { codec_type: string; codec_name: string; height?: number; has_b_frames?: number }[];
};

const probe = (name: string, bytes: ArrayBuffer): Probe => {
	const file = join(OUT, name);
	writeFileSync(file, new Uint8Array(bytes));
	// Decoding the whole file makes ffmpeg report broken timestamps or packets on stderr.
	const errors = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
	expect(errors.toString()).toBe('');
	return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString());
};

const hooks = (stopSignal = new AbortController().signal): EngineHooks & { fractions: (number | null)[] } => {
	const fractions: (number | null)[] = [];
	return { fetchFn: fetch, stopSignal, onProgress: fraction => fractions.push(fraction), fractions };
};

const expectAv = (result: Probe, height: number) => {
	const video = result.streams.find(stream => stream.codec_type === 'video');
	const audio = result.streams.find(stream => stream.codec_type === 'audio');
	expect(video).toMatchObject({ codec_name: 'h264', height });
	expect(audio).toMatchObject({ codec_name: 'aac' });
	expect(Number(result.format.duration)).toBeGreaterThan(11.5);
	expect(Number(result.format.duration)).toBeLessThan(12.5);
};

describe.skipIf(!existsSync(FIXTURES))('engine against local fixtures', () => {
	let server: FixtureServer;

	beforeAll(async () => {
		mkdirSync(OUT, { recursive: true });
		server = await serveFixtures(FIXTURES);
	});
	afterAll(() => server.close());

	it('remuxes the best HLS variant of a TS master playlist', async () => {
		const target = new BufferTarget();
		const run = hooks();
		await downloadHls({ url: `${server.origin}/hls/master.m3u8`, height: null, audioOnly: false, live: false }, target, run);
		expectAv(probe('hls-best.mp4', target.buffer!), 360);
		expect(run.fractions.at(-1)).toBeCloseTo(1, 1);
	});

	it('remuxes a chosen lower HLS variant', async () => {
		const target = new BufferTarget();
		await downloadHls({ url: `${server.origin}/hls/master.m3u8`, height: 180, audioOnly: false, live: false }, target, hooks());
		expectAv(probe('hls-180.mp4', target.buffer!), 180);
	});

	it('decrypts AES-128 HLS', async () => {
		const target = new BufferTarget();
		await downloadHls({ url: `${server.origin}/hls-aes/index.m3u8`, height: null, audioOnly: false, live: false }, target, hooks());
		expectAv(probe('hls-aes.mp4', target.buffer!), 360);
	});

	it('merges fMP4 HLS video with its separate audio rendition', async () => {
		const target = new BufferTarget();
		await downloadHls({ url: `${server.origin}/hls-fmp4/master.m3u8`, height: null, audioOnly: false, live: false }, target, hooks());
		expectAv(probe('hls-fmp4.mp4', target.buffer!), 360);
	});

	it('extracts audio only from HLS', async () => {
		const target = new BufferTarget();
		await downloadHls({ url: `${server.origin}/hls/master.m3u8`, height: null, audioOnly: true, live: false }, target, hooks());
		const result = probe('hls-audio.m4a', target.buffer!);
		expect(result.streams.map(stream => stream.codec_type)).toEqual(['audio']);
	});

	it('merges DASH video and audio representations', async () => {
		const url = `${server.origin}/dash/manifest.mpd`;
		const summary = summarizeDash(await (await fetch(url)).text(), url)!;
		expect(summary.videos).toHaveLength(1);
		expect(summary.audios).toHaveLength(1);
		expect(summary.drm).toBeUndefined();

		const target = new BufferTarget();
		const run = hooks();
		await downloadDash(summary.videos[0]!, summary.audios[0]!, target, run);
		expectAv(probe('dash.mp4', target.buffer!), 360);
		expect(run.fractions.at(-1)).toBe(1);
	});

	it('merges a picture-only file with its sound-only file', async () => {
		const target = new BufferTarget();
		await downloadPair(`${server.origin}/picture.mp4`, `${server.origin}/sound.mp4`, target, hooks());
		expectAv(probe('pair.mp4', target.buffer!), 360);
	});

	describe('plain files from awkward servers', () => {
		const source = () => readFileSync(join(FIXTURES, 'direct.mp4'));
		/** Serves the fixture through `respond`, which decides how each request misbehaves. */
		const awkward = async (respond: (range: [number, number] | null, file: Buffer, response: import('node:http').ServerResponse) => void) => {
			const file = source();
			const server = createServer((request, response) => {
				const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
				respond(match ? [Number(match[1]), match[2] ? Math.min(Number(match[2]), file.length - 1) : file.length - 1] : null, file, response);
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v.mp4`, close: () => server.close() };
		};
		const fetchAll = async (url: string) => {
			const chunks: Uint8Array[] = [];
			await downloadFile(url, async chunk => {
				chunks.push(chunk.slice());
			}, hooks());
			return Buffer.concat(chunks);
		};

		it('keeps going when each answer carries less than was asked for', async () => {
			const server = await awkward((range, file, response) => {
				const [start, end] = range!;
				const stop = Math.min(end, start + 99_999);
				response.writeHead(206, { 'Content-Range': `bytes ${start}-${stop}/${file.length}`, 'Content-Length': stop - start + 1 }).end(file.subarray(start, stop + 1));
			});
			try {
				expect((await fetchAll(server.url)).equals(source())).toBe(true);
			} finally {
				server.close();
			}
		});

		it('resumes after the connection is dropped mid-transfer', async () => {
			let drops = 0;
			const server = await awkward((range, file, response) => {
				const [start, end] = range!;
				response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Content-Length': end - start + 1 });
				if (drops < 2) {
					drops++;
					response.write(file.subarray(start, start + 150_000), () => response.destroy());
				} else {
					response.end(file.subarray(start, end + 1));
				}
			});
			try {
				expect((await fetchAll(server.url)).equals(source())).toBe(true);
				expect(drops).toBe(2);
			} finally {
				server.close();
			}
		}, 20_000);

		it('downloads from a server that ignores Range', async () => {
			const server = await awkward((_range, file, response) => {
				response.writeHead(200, { 'Content-Length': file.length }).end(file);
			});
			try {
				expect((await fetchAll(server.url)).equals(source())).toBe(true);
			} finally {
				server.close();
			}
		});

		it('continues a file that already holds its first part, asking only for the rest', async () => {
			const asked: number[] = [];
			const server = await awkward((range, file, response) => {
				const [start, end] = range!;
				asked.push(start);
				response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Content-Length': end - start + 1 }).end(file.subarray(start, end + 1));
			});
			try {
				const chunks: Uint8Array[] = [source().subarray(0, 400_000)];
				await downloadFile(server.url, async chunk => {
					chunks.push(chunk.slice());
				}, hooks(), { from: 400_000, restart: async () => { chunks.length = 0; } });
				expect(Buffer.concat(chunks).equals(source())).toBe(true);
				expect(asked).toEqual([400_000]);
			} finally {
				server.close();
			}
		});

		it('starts over when asked to continue from a server that ignores Range', async () => {
			const server = await awkward((_range, file, response) => {
				response.writeHead(200, { 'Content-Length': file.length }).end(file);
			});
			try {
				const chunks: Uint8Array[] = [Buffer.from('stale partial data')];
				await downloadFile(server.url, async chunk => {
					chunks.push(chunk.slice());
				}, hooks(), { from: 18, restart: async () => { chunks.length = 0; } });
				expect(Buffer.concat(chunks).equals(source())).toBe(true);
			} finally {
				server.close();
			}
		});

		it('fails rather than saving a truncated file when the rest never comes', async () => {
			const server = await awkward((range, file, response) => {
				const [start] = range!;
				if (start === 0) {
					response.writeHead(206, { 'Content-Range': `bytes 0-74999/${file.length}`, 'Content-Length': 75_000 }).end(file.subarray(0, 75_000));
				} else {
					response.writeHead(206, { 'Content-Range': `bytes ${start}-${start}/${file.length}`, 'Content-Length': 0 }).end();
				}
			});
			try {
				await expect(fetchAll(server.url)).rejects.toThrow(/75000 of \d+ bytes/);
			} finally {
				server.close();
			}
		}, 20_000);
	});

	it('finalizes a playable partial file when stopped midway', async () => {
		const stop = new AbortController();
		const run = hooks(stop.signal);
		run.onProgress = fraction => {
			if (fraction !== null && fraction > 0.3) {
				stop.abort();
			}
		};
		const target = new BufferTarget();
		await downloadHls({ url: `${server.origin}/hls/master.m3u8`, height: null, audioOnly: false, live: false }, target, run);
		const result = probe('hls-stopped.mp4', target.buffer!);
		expect(Number(result.format.duration)).toBeGreaterThan(1);
		expect(Number(result.format.duration)).toBeLessThan(11);
	});

	it('records a live playlist until stopped and finalizes the file', async () => {
		// A playlist without an end marker that gains one segment per request, like a live stream.
		const lines = readFileSync(join(FIXTURES, 'hls/v0.m3u8'), 'utf8').split('\n');
		const head = lines.filter(line => line.startsWith('#') && !line.startsWith('#EXTINF') && !/ENDLIST|PLAYLIST-TYPE/.test(line));
		const segments = lines.filter(line => line.endsWith('.ts'));
		let available = 1;
		const live = createServer((request, response) => {
			if (request.url === '/live.m3u8') {
				const body = [...head, ...segments.slice(0, available).flatMap(name => ['#EXTINF:2.0,', `${server.origin}/hls/${name}`])];
				available = Math.min(available + 1, segments.length);
				response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(body.join('\n'));
			} else {
				response.writeHead(404).end();
			}
		});
		await new Promise<void>(resolve => live.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(live.address() as { port: number }).port}/live.m3u8`;
		expect(summarizeHls(await (await fetch(url)).text())!.live).toBe(true);

		const stop = new AbortController();
		setTimeout(() => stop.abort(), 5000);
		const target = new BufferTarget();
		try {
			await downloadHls({ url, height: null, audioOnly: false, live: true }, target, hooks(stop.signal));
		} finally {
			live.close();
		}
		const result = probe('hls-live.mp4', target.buffer!);
		expect(Number(result.format.duration)).toBeGreaterThan(3);
	}, 20_000);

	it('summarizes the fixture playlists', () => {
		const master = summarizeHls(readFileSync(join(FIXTURES, 'hls/master.m3u8'), 'utf8'))!;
		expect(master.isMaster).toBe(true);
		expect(master.variants.map(variant => variant.height)).toEqual([360, 180]);

		const media = summarizeHls(readFileSync(join(FIXTURES, 'hls-aes/index.m3u8'), 'utf8'))!;
		expect(media).toMatchObject({ isMaster: false, live: false, drm: undefined });
		expect(media.duration).toBeCloseTo(12, 0);
	});
});
