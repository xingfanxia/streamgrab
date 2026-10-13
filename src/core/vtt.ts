/**
 * Joins the WebVTT segments of an HLS subtitle rendition into one file. Each segment repeats the file header, and
 * cues that span a segment boundary appear in both neighbours, so headers and repeated cues are dropped.
 */
export const mergeVtt = (segments: string[]): string => {
	const cues: string[] = [];
	const seen = new Set<string>();

	for (const segment of segments) {
		const blocks = segment.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
		for (const block of blocks) {
			const trimmed = block.trim();
			if (!trimmed.includes('-->') || seen.has(trimmed)) {
				continue;
			}
			seen.add(trimmed);
			cues.push(trimmed);
		}
	}

	return `WEBVTT\n\n${cues.join('\n\n')}\n`;
};
