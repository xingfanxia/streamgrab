// Registers the yt-dlp bridge (native/host.mjs) with the browser so the extension may start it.
//
//   node scripts/install-host.mjs              install for Google Chrome
//   node scripts/install-host.mjs --browser arc|brave|chromium|edge
//   node scripts/install-host.mjs --uninstall
//
// It writes two files and nothing else: a launcher script in this user's application-support directory, and a
// manifest in the browser's NativeMessagingHosts directory that points at it.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const HOST_NAME = 'io.github.xingfanxia.streamgrab';
const root = resolve(import.meta.dirname, '..');
const extensionId = readFileSync(join(root, 'native/extension-id.txt'), 'utf8').trim();

const option = name => {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
};

const support = platform() === 'darwin' ? join(homedir(), 'Library/Application Support') : join(homedir(), '.config');
const browsers = platform() === 'darwin'
	? { chrome: 'Google/Chrome', arc: 'Arc/User Data', brave: 'BraveSoftware/Brave-Browser', chromium: 'Chromium', edge: 'Microsoft Edge' }
	: { chrome: 'google-chrome', brave: 'BraveSoftware/Brave-Browser', chromium: 'chromium', edge: 'microsoft-edge' };
if (platform() === 'win32') {
	throw new Error('Windows registers native hosts through the registry, which this script does not do.');
}

const browser = option('browser') ?? 'chrome';
if (!browsers[browser]) {
	throw new Error(`Unknown browser "${browser}". Use one of: ${Object.keys(browsers).join(', ')}`);
}
// --dir and --output-dir exist for the end-to-end test, which uses a throwaway browser profile.
const hostsDir = option('dir') ?? join(support, browsers[browser], 'NativeMessagingHosts');
const manifestPath = join(hostsDir, `${HOST_NAME}.json`);
const launcherPath = option('dir') ? join(hostsDir, 'streamgrab-host.sh') : join(support, 'streamgrab', 'host.sh');

if (process.argv.includes('--uninstall')) {
	rmSync(manifestPath, { force: true });
	rmSync(launcherPath, { force: true });
	console.log(`Removed ${manifestPath}`);
	process.exit(0);
}

const which = command => {
	try {
		return execFileSync('which', [command]).toString().trim();
	} catch {
		return '';
	}
};

const ytDlp = which('yt-dlp');
if (!ytDlp) {
	throw new Error('yt-dlp was not found on the PATH. Install it first, for example with `brew install yt-dlp`.');
}
const ffmpeg = which('ffmpeg');
if (!ffmpeg) {
	console.warn('ffmpeg was not found; yt-dlp needs it to merge video with audio and to convert subtitles.');
}

// The browser starts the host with a bare environment, so every path is pinned here at install time.
const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
const path = [...new Set([dirname(ytDlp), ffmpeg && dirname(ffmpeg), dirname(process.execPath), '/usr/bin', '/bin'].filter(Boolean))].join(':');
const launcher = [
	'#!/bin/sh',
	`export PATH=${quote(path)}`,
	`export STREAMGRAB_YT_DLP=${quote(ytDlp)}`,
	`export STREAMGRAB_FFMPEG=${quote(ffmpeg)}`,
	...(option('output-dir') ? [`export STREAMGRAB_OUTPUT_DIR=${quote(resolve(option('output-dir')))}`] : []),
	`exec ${quote(process.execPath)} ${quote(join(root, 'native/host.mjs'))}`,
	'',
].join('\n');

mkdirSync(dirname(launcherPath), { recursive: true });
writeFileSync(launcherPath, launcher);
chmodSync(launcherPath, 0o755);

mkdirSync(hostsDir, { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify({
	name: HOST_NAME,
	description: 'streamgrab bridge to yt-dlp',
	path: launcherPath,
	type: 'stdio',
	allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, '\t')}\n`);

console.log(`Installed the yt-dlp bridge for ${option('dir') ? hostsDir : browser}.`);
console.log(`  yt-dlp:   ${ytDlp}`);
console.log(`  manifest: ${manifestPath}`);
console.log(`  launcher: ${launcherPath}`);
