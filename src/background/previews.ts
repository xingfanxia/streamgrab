import type { Preview } from '../shared/messages';
import { dropRule, ensureEngine, holdEngine, openRule, sendToEngine } from './jobs';
import { loadState, mutate } from './state';

let queue: Promise<void> = Promise.resolve();

/**
 * Fills in thumbnails and durations for a tab's media. This runs when the popup asks rather than at detection, so
 * pages the user never acts on cost no extra requests. Items are handled one at a time.
 */
export const previewTab = (tabId: number) => {
	queue = queue.then(async () => {
		const state = await loadState();
		const pending = Object.values(state.media[tabId] ?? {}).filter(media => !media.previewed && !media.drm);
		if (pending.length === 0) {
			return;
		}

		const release = holdEngine();
		try {
			await ensureEngine();
			for (const media of pending) {
				if (media.kind === 'page') {
					continue;
				}
				await mutate(current => {
					const item = current.media[tabId]?.[media.key];
					if (item) {
						item.previewed = true;
					}
				});

				const id = `preview-${crypto.randomUUID()}`;
				await openRule(id, media.replayHeaders);
				try {
					const preview = await sendToEngine({ to: 'engine', type: 'preview', id, kind: media.kind, url: media.url }) as Preview | undefined;
					await mutate(current => {
						const item = current.media[tabId]?.[media.key];
						if (!item || !preview) {
							return;
						}
						item.thumbnail = preview.thumbnail;
						item.duration ??= preview.duration;

						// Two manifests on one host with exactly the same running time are one video offered twice,
						// for instance with and without subtitles. The fuller one is kept.
						const richness = (entry: typeof item) => entry.variants.length + (entry.subtitles?.length ?? 0) * 10;
						for (const other of Object.values(current.media[tabId]!)) {
							const twin = other !== item
								&& other.kind === item.kind
								&& item.duration !== undefined
								&& other.duration !== undefined
								&& Math.abs(other.duration - item.duration) < 0.05
								&& new URL(other.url).host === new URL(item.url).host;
							if (twin) {
								delete current.media[tabId]![richness(other) >= richness(item) ? item.key : other.key];
								break;
							}
						}
					});
				} finally {
					await dropRule(id);
				}
			}
		} finally {
			await release();
		}
	}).catch(error => console.warn('streamgrab: preview failed', error));
	return queue;
};
