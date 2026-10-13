import { fetchOk, withRetry } from './fetching';
import type { EngineHooks } from './remux';

/** Bytes asked for per request. Players fetch media in pieces, and some servers cut off a single long transfer. */
const CHUNK = 8 * 1024 * 1024;

const totalFromRange = (response: Response): number | null => {
	const total = Number(/\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')?.[1]);
	return Number.isFinite(total) && total > 0 ? total : null;
};

/**
 * Downloads a plain file to `write`, in order. The file is requested piece by piece with Range, each piece retried
 * on its own and continued from the last byte received, so a dropped connection costs little. A transfer only counts
 * as finished when every byte of the stated size has arrived: a server closing early is a failure, not the end.
 */
export const downloadFile = async (
	url: string,
	write: (chunk: Uint8Array<ArrayBuffer>) => Promise<void>,
	hooks: EngineHooks,
) => {
	let received = 0;
	let total: number | null = null;
	/** False once the server has answered a Range request with the whole file, meaning it cannot resume. */
	let ranged = true;
	let finished = false;

	while (!finished) {
		await withRetry(async () => {
			const from = received;
			const response = await fetchOk(hooks.fetchFn, url, {
				signal: hooks.stopSignal,
				headers: ranged ? { Range: `bytes=${from}-${from + CHUNK - 1}` } : undefined,
			});

			if (response.status === 206) {
				total = totalFromRange(response) ?? total;
			} else {
				if (from > 0) {
					throw new Error('The server stopped partway and does not support resuming');
				}
				ranged = false;
				const length = Number(response.headers.get('content-length'));
				total = length > 0 ? length : null;
			}

			const reader = response.body!.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				await write(value as Uint8Array<ArrayBuffer>);
				received += value.byteLength;
				hooks.onProgress(total ? Math.min(1, received / total) : null);
			}

			if (total !== null) {
				finished = received >= total;
				if (!finished && (!ranged || received === from)) {
					throw new Error(`The server sent ${received} of ${total} bytes and stopped`);
				}
			} else {
				// No stated size: a ranged answer shorter than asked for is the tail, and a plain one ends when it ends.
				finished = !ranged || received - from < CHUNK;
			}
		}, hooks.stopSignal);
	}
};
