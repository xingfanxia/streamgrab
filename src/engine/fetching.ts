import type { Part } from '../core/mpd';

const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class HttpError extends Error {
	constructor(readonly status: number, url: string) {
		super(`HTTP ${status} for ${url}`);
	}
}

const isPermanent = (error: unknown) => (
	error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
);

/** Runs `attempt` until it succeeds, backing off linearly. Client errors and aborts are not retried. */
export const withRetry = async <T>(attempt: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
	for (let tries = 1; ; tries++) {
		try {
			return await attempt();
		} catch (error) {
			if (signal?.aborted || isPermanent(error) || tries >= MAX_ATTEMPTS) {
				throw error;
			}
			await sleep(500 * tries);
		}
	}
};

export const fetchOk = async (fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<Response> => {
	const response = await fetchFn(url, init);
	if (!response.ok) {
		throw new HttpError(response.status, url);
	}
	return response;
};

const rangeInit = (part: Part, signal?: AbortSignal): RequestInit => ({
	signal,
	headers: part.range
		? { Range: `bytes=${part.range.offset}-${part.range.offset + part.range.length - 1}` }
		: undefined,
});

/**
 * Concatenates the given parts into one byte stream, fetching them lazily and in order. Each part is buffered whole so
 * a failed transfer can simply be retried; a lone part (a single self-contained file) is streamed through instead.
 */
export const partStream = (
	parts: Part[],
	fetchFn: typeof fetch,
	onPartDone: () => void,
): ReadableStream<Uint8Array> => {
	const abort = new AbortController();
	let index = 0;
	let passthrough: ReadableStreamDefaultReader<Uint8Array> | null = null;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (parts.length === 1) {
				passthrough ??= (await fetchOk(fetchFn, parts[0]!.url, rangeInit(parts[0]!, abort.signal))).body!.getReader();
				const { done, value } = await passthrough.read();
				if (done) {
					onPartDone();
					controller.close();
				} else {
					controller.enqueue(value);
				}
				return;
			}

			const part = parts[index++];
			if (!part) {
				controller.close();
				return;
			}

			const bytes = await withRetry(async () => {
				const response = await fetchOk(fetchFn, part.url, rangeInit(part, abort.signal));
				return new Uint8Array(await response.arrayBuffer());
			}, abort.signal);
			onPartDone();
			controller.enqueue(bytes);
		},
		cancel() {
			abort.abort();
		},
	});
};
