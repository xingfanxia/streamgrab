import { emptyState, STATE_KEY, type State } from '../shared/messages';

let cached: Promise<State> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const loadState = (): Promise<State> => {
	cached ??= chrome.storage.session.get(STATE_KEY).then(stored => (stored[STATE_KEY] as State | undefined) ?? emptyState());
	return cached;
};

const flush = async () => {
	flushTimer = null;
	await chrome.storage.session.set({ [STATE_KEY]: await loadState() });
};

/** Applies a change to the shared state and schedules it to be persisted, which also notifies open UIs. */
export const mutate = async <T>(change: (state: State) => T): Promise<T> => {
	const result = change(await loadState());
	flushTimer ??= setTimeout(() => void flush(), 150);
	return result;
};
