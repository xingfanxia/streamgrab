import { findPartner } from '../core/pairing';
import type { DetectedMedia } from '../core/types';
import type { Preview } from '../shared/messages';
import { dropRule, ensureEngine, holdEngine, openRule, sendToEngine } from './jobs';
import { loadState, mutate } from './state';

/** How many items are looked into at once. */
const CONCURRENCY = 4;

const previewOne = async (tabId: number, media: DetectedMedia & { kind: 'file' | 'hls' | 'dash' }) => {
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
			item.tracks = preview.tracks;
			if (preview.tracks === 'audio') {
				item.hasVideo = false;
			}

			// Picture and sound served as two files become one item that downloads both.
			const partner = findPartner(item, Object.values(current.media[tabId]!));
			if (partner) {
				const [picture, sound] = item.tracks === 'video' ? [item, partner] : [partner, item];
				picture.audioUrl = sound.url;
				picture.size = picture.size && sound.size ? picture.size + sound.size : undefined;
				delete current.media[tabId]![sound.key];
				return;
			}

			// Clips of a couple of seconds are interface effects and stickers, not something to save.
			if (item.kind === 'file' && item.duration !== undefined && item.duration < 4 && (item.size ?? 0) < 500_000) {
				delete current.media[tabId]![item.key];
				return;
			}

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
};

/**
 * Fills in thumbnails and running times for a tab's media: when media is found on the tab in front, and again when
 * the popup opens. Each item is claimed before it is looked into, so overlapping calls never repeat work.
 */
export const previewTab = async (tabId: number) => {
	const pending = await mutate(state => {
		const items = Object.values(state.media[tabId] ?? {}).filter(media => !media.previewed && !media.drm && media.kind !== 'page');
		for (const item of items) {
			item.previewed = true;
		}
		return items.map(item => ({ ...item })).sort((a, b) => b.detectedAt - a.detectedAt);
	});
	if (pending.length === 0) {
		return;
	}

	const release = holdEngine();
	try {
		await ensureEngine();
		const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
			for (let media = pending.shift(); media; media = pending.shift()) {
				await previewOne(tabId, media as DetectedMedia & { kind: 'file' | 'hls' | 'dash' }).catch(error => console.warn('streamgrab: preview failed', error));
			}
		});
		await Promise.all(workers);
	} finally {
		await release();
	}
};
