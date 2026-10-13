/**
 * Hands out turns per key, a limited number at a time, in the order asked. Used for transfers from one server:
 * media servers commonly cap the connections a visitor may hold, the page's own player already holds one, and too
 * many transfers at once get some of them cut off.
 */
export const createTurns = (defaultLimit: number, learned: Record<string, number> = {}) => {
	type Line = { limit: number; active: number; waiting: { start: () => void; cancelled: boolean }[] };
	const lines = new Map<string, Line>();
	const lineFor = (key: string) => {
		let line = lines.get(key);
		if (!line) {
			lines.set(key, line = { limit: learned[key] ?? defaultLimit, active: 0, waiting: [] });
		}
		return line;
	};

	const advance = (line: Line) => {
		while (line.active < line.limit && line.waiting.length > 0) {
			const next = line.waiting.shift()!;
			if (!next.cancelled) {
				line.active++;
				next.start();
			}
		}
	};

	return {
		/**
		 * Resolves when it is the caller's turn, with the function that ends it. Aborting `signal` while waiting
		 * gives up the place in line at once and rejects.
		 */
		take: (key: string, signal?: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
			const line = lineFor(key);
			const end = () => {
				line.active--;
				advance(line);
			};
			const waiter = { start: () => resolve(end), cancelled: false };
			signal?.addEventListener('abort', () => {
				if (line.waiting.includes(waiter)) {
					waiter.cancelled = true;
					reject(new DOMException('Canceled', 'AbortError'));
				}
			}, { once: true });
			line.waiting.push(waiter);
			advance(line);
		}),
		/** How many turns are in progress for a key. */
		active: (key: string) => lineFor(key).active,
		limitOf: (key: string) => lineFor(key).limit,
		/** Changes how many may run at once for a key from now on; turns in progress are left to finish. */
		setLimit: (key: string, limit: number) => {
			const line = lineFor(key);
			line.limit = limit;
			advance(line);
		},
	};
};
