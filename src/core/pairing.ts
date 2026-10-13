import type { DetectedMedia } from './types';

/**
 * Some players fetch a video's picture and sound as two separate files. Given a file known to hold only one of the
 * two, finds the file on the same tab that holds the other, recognised by having the same running time.
 */
export const findPartner = (item: DetectedMedia, others: DetectedMedia[]): DetectedMedia | undefined => {
	if (item.kind !== 'file' || item.duration === undefined || item.audioUrl || !item.tracks) {
		return undefined;
	}
	const wanted = item.tracks === 'video' ? 'audio' : item.tracks === 'audio' ? 'video' : null;
	if (!wanted) {
		return undefined;
	}
	return others.find(other => (
		other !== item
		&& other.kind === 'file'
		&& other.tracks === wanted
		&& !other.audioUrl
		&& other.duration !== undefined
		&& Math.abs(other.duration - item.duration!) < 0.5
	));
};
