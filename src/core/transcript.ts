/** One subtitle cue: when it shows, in seconds, and its text lines with markup removed. */
type Cue = { start: number; end: number; lines: string[] };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: '\'', lrm: '', rlm: '' };

const toSeconds = (stamp: string): number => {
	const parts = stamp.replace(',', '.').split(':').map(Number);
	return parts.reduce((total, part) => total * 60 + part, 0);
};

const cleanLine = (line: string): string => line
	// A voice tag names the speaker; everything else in angle brackets or braces is styling or karaoke timing.
	.replace(/<v(?:\.[^\s>]+)*\s+([^>]+)>/g, '$1: ')
	.replace(/<[^>]*>/g, '')
	.replace(/\{\\[^}]*\}/g, '')
	.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
		if (name.startsWith('#x') || name.startsWith('#X')) {
			return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
		}
		if (name.startsWith('#')) {
			return String.fromCodePoint(Number(name.slice(1)));
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	})
	.replace(/\s+/g, ' ')
	.trim();

/** Reads the cues of a WebVTT or SubRip file; the two differ only in ways that do not matter here. */
const parseCues = (text: string): Cue[] => {
	const cues: Cue[] = [];
	const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
	for (const block of blocks) {
		const lines = block.split('\n');
		const timing = lines.findIndex(line => line.includes('-->'));
		if (timing === -1) {
			continue;
		}
		const match = /((?:\d+:)?\d+:\d+[.,]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[.,]\d+)/.exec(lines[timing]!);
		if (!match) {
			continue;
		}
		const content = lines.slice(timing + 1).map(cleanLine).filter(Boolean);
		if (content.length > 0) {
			cues.push({ start: toSeconds(match[1]!), end: toSeconds(match[2]!), lines: content });
		}
	}
	return cues;
};

const CJK = /[぀-ヿ㐀-鿿豈-﫿＀-￯　-〿]/;
const SENTENCE_END = /[.!?。！？…]["'”’)\]]?$/;

/** Joins two pieces of running text: scripts written without spaces are not given one. */
const join = (left: string, right: string): string => {
	if (!left) {
		return right;
	}
	return CJK.test(left.at(-1)!) || CJK.test(right[0]!) ? left + right : `${left} ${right}`;
};

/** A pause this long between cues starts a new paragraph. */
const PAUSE_SECONDS = 2.5;
/** A paragraph past this length ends at its next sentence end, so unpunctuated captions still get broken up. */
const LONG_PARAGRAPH = 700;

/**
 * Turns a subtitle file into readable text. Timings and markup go; lines repeated from one cue to the next, as in
 * captions that scroll up a line at a time, are kept once; and paragraphs follow the pauses in speech.
 */
export const toTranscript = (subtitles: string): string => {
	const paragraphs: string[] = [];
	let paragraph = '';
	let lastEnd = 0;
	const recent: string[] = [];

	for (const cue of parseCues(subtitles)) {
		const fresh = cue.lines.filter(line => !recent.includes(line));
		if (fresh.length === 0) {
			lastEnd = Math.max(lastEnd, cue.end);
			continue;
		}

		const paused = paragraph && cue.start - lastEnd >= PAUSE_SECONDS;
		const long = paragraph.length >= LONG_PARAGRAPH && SENTENCE_END.test(paragraph);
		if (paused || long || paragraph.length >= LONG_PARAGRAPH * 2) {
			paragraphs.push(paragraph);
			paragraph = '';
		}

		for (const line of fresh) {
			paragraph = join(paragraph, line);
			recent.push(line);
		}
		// Only the last few lines can recur; a line said again later in the video is a real repeat.
		recent.splice(0, Math.max(0, recent.length - 4));
		lastEnd = cue.end;
	}
	if (paragraph) {
		paragraphs.push(paragraph);
	}
	return paragraphs.length > 0 ? `${paragraphs.join('\n\n')}\n` : '';
};
