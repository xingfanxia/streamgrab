#!/usr/bin/env node
// Native messaging host: runs the locally installed yt-dlp on behalf of the extension. One process serves one
// request (a probe or a download) and exits; closing the connection cancels whatever is running.
//
// Chrome frames each message as a 4-byte little-endian length followed by UTF-8 JSON, in both directions.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const YT_DLP = process.env.STREAMGRAB_YT_DLP || 'yt-dlp';
const FFMPEG = process.env.STREAMGRAB_FFMPEG || '';
const OUTPUT_DIR = process.env.STREAMGRAB_OUTPUT_DIR || join(homedir(), 'Downloads');

/** Languages for which machine-made captions are offered; sites list far more than anyone wants to scroll. */
const AUTO_CAPTION_LANGUAGES = /^(zh|zh-Hans|zh-Hant|zh-CN|zh-TW|en|ja|ko)$/;

const send = message => {
	const body = Buffer.from(JSON.stringify(message));
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length);
	process.stdout.write(Buffer.concat([header, body]));
};

let child = null;
let scratch = null;

const cleanUp = () => {
	if (scratch) {
		rmSync(scratch, { recursive: true, force: true });
		scratch = null;
	}
};

const finish = message => {
	send(message);
	cleanUp();
	// Give stdout a moment to flush before the process goes away.
	setTimeout(() => process.exit(0), 50);
};

/** Writes the browser's cookies for the site as a Netscape cookie file, so yt-dlp sees the user's login. */
const writeCookies = cookies => {
	if (!Array.isArray(cookies) || cookies.length === 0) {
		return [];
	}
	scratch = mkdtempSync(join(tmpdir(), 'streamgrab-'));
	const file = join(scratch, 'cookies.txt');
	const lines = cookies.map(cookie => [
		(cookie.httpOnly ? '#HttpOnly_' : '') + cookie.domain,
		cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE',
		cookie.path,
		cookie.secure ? 'TRUE' : 'FALSE',
		Math.round(cookie.expirationDate ?? 0),
		cookie.name,
		cookie.value,
	].join('\t'));
	writeFileSync(file, `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`, { mode: 0o600 });
	return ['--cookies', file];
};

const commonArgs = request => [
	'--no-playlist',
	'--no-warnings',
	'--no-colors',
	...(FFMPEG ? ['--ffmpeg-location', dirname(FFMPEG)] : []),
	...writeCookies(request.cookies),
];

const run = (args, onLine) => new Promise(resolve => {
	child = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
	let pending = '';
	let stderr = '';
	child.stdout.on('data', chunk => {
		pending += chunk;
		const lines = pending.split(/\r?\n/);
		pending = lines.pop();
		lines.forEach(onLine);
	});
	child.stderr.on('data', chunk => {
		stderr = (stderr + chunk).slice(-4000);
	});
	child.on('error', error => resolve({ code: -1, stderr: error.message }));
	child.on('close', code => {
		if (pending) {
			onLine(pending);
		}
		resolve({ code, stderr });
	});
});

const lastErrorLine = stderr => (
	stderr.split('\n').map(line => line.trim()).filter(line => line.startsWith('ERROR')).pop()
	?? stderr.trim().split('\n').pop()
	?? 'yt-dlp failed'
);

const probe = async request => {
	let json = '';
	const { code, stderr } = await run(['-J', ...commonArgs(request), '--', request.url], line => {
		json += line;
	});
	if (code !== 0) {
		finish({ type: 'error', message: lastErrorLine(stderr) });
		return;
	}

	const info = JSON.parse(json);
	const formats = info.formats ?? [];
	const videos = formats.filter(format => format.vcodec && format.vcodec !== 'none' && format.height);
	const heights = [...new Set(videos.map(format => format.height))];
	// Bitrate per height (best video at that height, plus the best separate audio when the video has none), which
	// lets the extension estimate a size before anything is downloaded.
	// Some sites give a bitrate, others only a file size; either yields kilobits per second.
	const rateOf = format => format.tbr
		|| (info.duration ? ((format.filesize || format.filesize_approx || 0) * 8) / info.duration / 1000 : 0);
	const audioRate = Math.max(0, ...formats.filter(format => format.vcodec === 'none' && format.acodec !== 'none').map(rateOf));
	const bitrates = {};
	for (const height of heights) {
		const best = videos.filter(format => format.height === height).sort((a, b) => rateOf(b) - rateOf(a))[0];
		if (rateOf(best)) {
			bitrates[height] = Math.round((rateOf(best) + (best.acodec === 'none' ? audioRate : 0)) * 1000);
		}
	}

	// Sites report the cover image in different places, and some still give an http address.
	const cover = [info.thumbnail, ...(info.thumbnails ?? []).map(entry => entry.url).reverse()]
		.find(url => typeof url === 'string' && /^https?:\/\//.test(url));
	const manual = Object.keys(info.subtitles ?? {}).filter(language => language !== 'live_chat' && language !== 'danmaku');
	const automatic = Object.keys(info.automatic_captions ?? {})
		.filter(language => (AUTO_CAPTION_LANGUAGES.test(language) || language.endsWith('-orig')) && !manual.includes(language));

	finish({
		type: 'info',
		id: String(info.id ?? ''),
		title: info.title ?? '',
		site: info.extractor_key ?? '',
		duration: typeof info.duration === 'number' ? info.duration : undefined,
		thumbnail: cover?.replace(/^http:/, 'https:'),
		bitrates,
		live: Boolean(info.is_live),
		heights: heights.sort((a, b) => b - a),
		hasVideo: heights.length > 0,
		subtitles: [
			...manual.map(language => ({ language, automatic: false })),
			...automatic.map(language => ({ language, automatic: true })),
		],
	});
};

const download = async request => {
	const args = [
		...commonArgs(request),
		'--newline',
		'--progress-template', 'download:SGP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
		'--print', 'after_move:SGF %(filepath)s',
		'--no-simulate',
		'-P', OUTPUT_DIR,
		'-o', '%(title).120B [%(id)s].%(ext)s',
	];

	if (request.subtitle) {
		// A subtitle track on its own, converted to SRT, which every player and editor reads.
		args.push(
			'--skip-download',
			request.subtitle.automatic ? '--write-auto-subs' : '--write-subs',
			'--sub-langs', request.subtitle.language,
			'--convert-subs', 'srt',
			'--print', 'before_dl:SGS %(requested_subtitles)j',
		);
	} else if (request.audioOnly) {
		args.push('-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a');
	} else {
		const height = Number(request.height);
		const cap = Number.isFinite(height) && height > 0 ? `[height<=${height}]` : '';
		args.push('-f', `bv*${cap}+ba/b${cap}/b`, '--merge-output-format', 'mp4');
	}

	const files = [];
	const { code, stderr } = await run([...args, '--', request.url], line => {
		if (line.startsWith('SGP ')) {
			const [downloaded, total, estimate] = line.slice(4).split(' ').map(Number);
			const size = total || estimate;
			send({ type: 'progress', bytes: downloaded || 0, fraction: size ? Math.min(1, downloaded / size) : null });
		} else if (line.startsWith('SGF ')) {
			files.push(line.slice(4));
		} else if (line.startsWith('SGS ')) {
			try {
				for (const track of Object.values(JSON.parse(line.slice(4)) ?? {})) {
					files.push(String(track.filepath).replace(/\.[^.]+$/, '.srt'));
				}
			} catch {
				// The subtitle path is informational; the download itself is unaffected.
			}
		}
	});

	if (code !== 0) {
		finish({ type: 'error', message: lastErrorLine(stderr) });
	} else if (files.length === 0) {
		finish({ type: 'error', message: request.subtitle ? 'No subtitles in that language' : 'yt-dlp produced no file' });
	} else {
		let bytes = 0;
		for (const file of files) {
			try {
				bytes += statSync(file).size;
			} catch {
				// A file yt-dlp renamed after reporting it simply does not count towards the size.
			}
		}
		finish({ type: 'done', files, bytes });
	}
};

const handle = request => {
	let url;
	try {
		url = new URL(request.url);
	} catch {
		url = null;
	}
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
		finish({ type: 'error', message: 'Only http and https pages can be downloaded' });
	} else if (request.op === 'probe') {
		void probe(request);
	} else if (request.op === 'download') {
		void download(request);
	} else {
		finish({ type: 'error', message: `Unknown operation ${request.op}` });
	}
};

let buffered = Buffer.alloc(0);
let handled = false;
process.stdin.on('data', chunk => {
	buffered = Buffer.concat([buffered, chunk]);
	if (handled || buffered.length < 4) {
		return;
	}
	const length = buffered.readUInt32LE(0);
	if (buffered.length >= 4 + length) {
		handled = true;
		handle(JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')));
	}
});

// The extension disconnecting closes stdin: stop yt-dlp and leave nothing behind.
process.stdin.on('end', () => {
	child?.kill('SIGTERM');
	cleanUp();
	process.exit(0);
});
