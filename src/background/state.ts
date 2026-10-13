import { emptyState, STATE_KEY, type State } from '../shared/messages';

let cached: Promise<State> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const loadState = (): Promise<State> => {
	cached ??= chrome.storage.session.get(STATE_KEY).then(stored => ({ ...emptyState(), ...(stored[STATE_KEY] as State | undefined) }));
	return cached;
};

const flush = async () => {
	flushTimer = null;
	const state = await loadState();
	try {
		await chrome.storage.session.set({ [STATE_KEY]: state });
	} catch (error) {
		// Almost certainly the storage quota. Thumbnails are the bulk of the state and can be read again, so they
		// go first; losing them is far better than the popup silently showing stale state from then on.
		console.warn('streamgrab: state did not fit, dropping thumbnails', error);
		for (const tab of Object.values(state.media)) {
			for (const media of Object.values(tab)) {
				if (media.thumbnail?.startsWith('data:')) {
					delete media.thumbnail;
				}
			}
		}
		for (const job of Object.values(state.jobs)) {
			delete job.details;
		}
		await chrome.storage.session.set({ [STATE_KEY]: state }).catch(again => console.error('streamgrab: state could not be saved', again));
	}
};

/** Applies a change to the shared state and schedules it to be persisted, which also notifies open UIs. */
export const mutate = async <T>(change: (state: State) => T): Promise<T> => {
	const result = change(await loadState());
	flushTimer ??= setTimeout(() => void flush(), 150);
	return result;
};
