/**
 * Hands out turns per key, one holder at a time, in the order asked. Used so transfers from one server run one after
 * another: media servers commonly cap the connections a visitor may hold, the page's own player already holds one,
 * and several transfers at once get some of them cut off.
 */
export const createTurns = () => {
	const queues = new Map<string, Promise<void>>();

	/** Resolves when it is the caller's turn, with the function that ends it. */
	return (key: string): Promise<() => void> => {
		let end!: () => void;
		const finished = new Promise<void>(resolve => {
			end = resolve;
		});
		const previous = queues.get(key) ?? Promise.resolve();
		queues.set(key, previous.then(() => finished));
		return previous.then(() => end);
	};
};
