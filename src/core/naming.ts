const MAX_BASENAME = 120;

/** Turns arbitrary text into a safe file name stem that works on every desktop OS. */
export const sanitizeBasename = (text: string): string => {
	const cleaned = text
		.normalize('NFC')
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.]+|[\s.]+$/g, '');
	return [...cleaned].slice(0, MAX_BASENAME).join('').trim() || 'video';
};

/** Removes the unread counter some sites prepend to the tab title, such as `(4) Home`. */
export const cleanTitle = (title: string): string => title.replace(/^\(\d+\+?\)\s*/, '').trim();

/** Small non-cryptographic string hash, used only as a de-duplication key. */
export const hashString = (text: string): string => {
	let a = 0x811c9dc5;
	let b = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a = Math.imul(a ^ code, 0x01000193);
		b = Math.imul(b + code, 0x85ebca6b) ^ (b >>> 13);
	}
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
};
