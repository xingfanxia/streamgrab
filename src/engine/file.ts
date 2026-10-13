import { fetchOk, withRetry } from './fetching';
import type { EngineHooks } from './remux';

/**
 * Streams a plain file to `write`. An interrupted transfer resumes from the last received byte with a Range request
 * when the server supports it, and otherwise fails rather than silently producing a file with a hole.
 */
export const downloadFile = async (
	url: string,
	write: (chunk: Uint8Array<ArrayBuffer>) => Promise<void>,
	hooks: EngineHooks,
) => {
	let received = 0;
	let total: number | null = null;

	await withRetry(async () => {
		const response = await fetchOk(hooks.fetchFn, url, {
			signal: hooks.stopSignal,
			headers: received > 0 ? { Range: `bytes=${received}-` } : undefined,
		});
		if (received > 0 && response.status !== 206) {
			throw new Error('The server does not support resuming an interrupted download');
		}
		if (total === null) {
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
			hooks.onProgress(total ? received / total : null);
		}
	}, hooks.stopSignal);
};
