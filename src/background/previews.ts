import { findPartner } from '../core/pairing';
import type { DetectedMedia } from '../core/types';
import type { Preview } from '../shared/messages';
import { dropRule, ensureEngine, holdEngine, openRule, sendToEngine } from './jobs';
import { loadState, mutate } from './state';

/** Orders qualities best first and numbers them, since ids are only meaningful within one item. */
const sortQualities = (variants: DetectedMedia['variants']) => [...variants]
	.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0))
	.map((variant, index) => ({ ...variant, id: String(index) }));

/** Folds `from` into `into`: every quality either offers, each remembering the manifest it comes from. */
const mergeManifests = (into: DetectedMedia, from: DetectedMedia) => {
	const tagged = (media: DetectedMedia) => media.variants.map(variant => ({ ...variant, url: variant.url ?? media.url }));
	const byHeight = new Map<number | string, DetectedMedia['variants'][number]>();
	for (const variant of [...tagged(into), ...tagged(from)]) {
		const key = variant.height ?? `${variant.url}#${variant.id}`;
		if (!byHeight.has(key) || (variant.bitrate ?? 0) > (byHeight.get(key)!.bitrate ?? 0)) {
			byHeight.set(key, variant);
		}
	}
	into.variants = sortQualities([...byHeight.values()]);
	into.subtitles = [...(into.subtitles ?? []), ...(from.subtitles ?? [])]
		.filter((track, index, all) => all.findIndex(entry => entry.label === track.label) === index);
	into.thumbnail ??= from.thumbnail;
	into.childUrls = [...(into.childUrls ?? []), ...(from.childUrls ?? []), from.url];
};

/** How many items are looked into at once. Kept low: media servers often cap connections per visitor. */
const CONCURRENCY = 2;

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
			// A playlist for a single quality does not state its picture size; the stream does.
			// It may already hold qualities gathered from other playlists, so only its own is checked for.
			const ownQuality = item.variants.some(variant => !variant.url || variant.url === item.url);
			if (!ownQuality && preview.height && item.kind !== 'file') {
				item.variants = sortQualities([...item.variants, { id: '', height: preview.height, url: item.url }]);
			}
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

			// Two manifests on one host with exactly the same running time are one video offered twice: with and
			// without subtitles, or once per quality. They become one item that offers every quality.
			// Renditions of one video differ in length by a frame or two of padding, so playlists of different
			// qualities are matched more loosely than ones that could be two videos of the same quality.
			const heightsOf = (media: DetectedMedia) => media.variants.flatMap(variant => variant.height ?? []);
			for (const other of Object.values(current.media[tabId]!)) {
				if (other === item || other.kind !== item.kind || (item.kind !== 'hls' && item.kind !== 'dash')) {
					continue;
				}
				if (item.duration === undefined || other.duration === undefined || new URL(other.url).host !== new URL(item.url).host) {
					continue;
				}
				const apart = Math.abs(other.duration - item.duration);
				const differentQualities = heightsOf(item).length > 0
					&& heightsOf(other).length > 0
					&& !heightsOf(item).some(height => heightsOf(other).includes(height));
				const twin = apart < 0.05 || (differentQualities && apart < 0.5);
				if (twin) {
					mergeManifests(other, item);
					delete current.media[tabId]![item.key];
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
