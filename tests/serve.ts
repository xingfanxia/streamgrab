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
 * Serves a directory over HTTP with Range support. When `requireReferer` is set, requests under `/protected/` (an
 * alias of the root) are rejected unless they carry that Referer, to exercise header replay.
 */
export const serveFixtures = async (root: string, requireReferer?: string): Promise<FixtureServer> => {
	const requests: FixtureServer['requests'] = [];
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
			createReadStream(file, { start, end }).pipe(response);
		} else {
			response.writeHead(200, { ...headers, 'Content-Length': size });
			createReadStream(file).pipe(response);
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
