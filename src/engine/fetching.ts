import type { Part } from '../core/mpd';

/** Attempts in a row that may fail without getting anywhere before giving up. */
const MAX_ATTEMPTS = 6;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class HttpError extends Error {
	constructor(readonly status: number, url: string) {
		// The query string is left out: it usually carries a signed token, and errors get shown and copied.
		super(`HTTP ${status} for ${url.split('?')[0]}`);
	}
}

const isPermanent = (error: unknown) => (
	error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
);

/**
 * Runs `attempt` until it succeeds, backing off a little longer each time. Client errors and aborts are not
 * retried. `progress`, when given, reports how far the work has got: a failed attempt that still moved forward does
 * not count against the limit, so a connection that keeps dropping but keeps delivering is never given up on.
 */
export const withRetry = async <T>(attempt: () => Promise<T>, signal?: AbortSignal, progress?: () => number): Promise<T> => {
	for (let tries = 1; ; tries++) {
		const before = progress?.();
		try {
			return await attempt();
		} catch (error) {
			if (progress && progress() !== before) {
				tries = 0;
			}
			if (signal?.aborted || isPermanent(error) || tries >= MAX_ATTEMPTS) {
				throw error;
			}
			await sleep(Math.min(8000, 700 * 2 ** Math.max(0, tries - 1)));
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
