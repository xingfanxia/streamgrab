import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, normalize } from 'node:path';

export type FixtureServer = {
	origin: string;
	/** Paths requested so far, for asserting what was fetched. */
	requests: { path: string; referer?: string }[];
	close: () => Promise<void>;
};

/**
 * Serves a directory over HTTP with Range support. Three aliases of the root behave like awkward media servers:
 * `/protected/` rejects requests without the given Referer, `/slow/` sends about 300 KB a second, and `/capped/`
 * sends 50 KB a second and allows one transfer at a time, cutting off any that starts while another is running.
 */
export const serveFixtures = async (root: string, requireReferer?: string): Promise<FixtureServer> => {
	const requests: FixtureServer['requests'] = [];
	let cappedBusy = false;

	/** Writes a file range to the response, at a limited rate when one is given. */
	const send = (response: import('node:http').ServerResponse, file: string, start: number, end: number, bytesPerSecond: number) => {
		if (!bytesPerSecond) {
			createReadStream(file, { start, end }).pipe(response);
			return;
		}
		const step = Math.ceil(bytesPerSecond / 10);
		const stream = createReadStream(file, { start, end, highWaterMark: step });
		stream.on('data', chunk => {
			stream.pause();
			response.write(chunk, () => setTimeout(() => stream.resume(), 100));
		});
		stream.on('end', () => response.end());
		response.on('close', () => stream.destroy());
	};
	const server: Server = createServer((request, response) => {
		let path = decodeURIComponent(new URL(request.url!, 'http://x').pathname);
		requests.push({ path, referer: request.headers.referer });

		if (path.startsWith('/protected/')) {
			if (requireReferer && !request.headers.referer?.startsWith(requireReferer)) {
				response.writeHead(403).end('referer required');
				return;
			}
			path = path.slice('/protected'.length);
		}

		let bytesPerSecond = 0;
		if (path.startsWith('/slow/')) {
			bytesPerSecond = 300_000;
			path = path.slice('/slow'.length);
		} else if (path.startsWith('/capped/')) {
			bytesPerSecond = 50_000;
			path = path.slice('/capped'.length);
			if (cappedBusy) {
				// Answered properly, then cut off shortly after it starts, as a connection cap does.
				setTimeout(() => response.destroy(), 400);
			} else {
				cappedBusy = true;
				response.on('close', () => {
					cappedBusy = false;
				});
			}
		}

		const file = join(root, normalize(path));
		let size: number;
		try {
			const stats = statSync(file);
			if (!stats.isFile()) {
				throw new Error('not a file');
			}
			size = stats.size;
		} catch {
			response.writeHead(404).end();
			return;
		}

		const types: Record<string, string> = {
			m3u8: 'application/vnd.apple.mpegurl',
			mpd: 'application/dash+xml',
			mp4: 'video/mp4',
			m4s: 'video/iso.segment',
			ts: 'video/mp2t',
			html: 'text/html',
		};
		const headers: Record<string, string | number> = {
			'Content-Type': types[file.split('.').pop()!] ?? 'application/octet-stream',
			'Accept-Ranges': 'bytes',
			'Access-Control-Allow-Origin': '*',
			'Cache-Control': 'no-store',
		};

		const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
		if (range) {
			const start = Number(range[1]);
			const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
			response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
			send(response, file, start, end, bytesPerSecond);
		} else {
			response.writeHead(200, { ...headers, 'Content-Length': size });
			send(response, file, 0, size - 1, bytesPerSecond);
		}
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as { port: number };
	return {
		origin: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise(resolve => server.close(() => resolve())),
	};
};
