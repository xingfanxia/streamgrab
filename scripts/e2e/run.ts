// End-to-end check: loads the built extension into Chromium, lets it detect the local fixtures on a page, downloads
// each through the popup UI and verifies the saved files with ffprobe. Run via `npm run e2e`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { serveFixtures } from '../../tests/serve';

const root = resolve(import.meta.dirname, '../..');
const fixtures = join(root, 'scratch/data/fixtures');
const shots = join(root, 'scratch/media/e2e');
const extension = join(root, 'dist');

if (!existsSync(join(fixtures, 'direct.mp4'))) {
	throw new Error('Fixtures are missing; run `npm run fixtures` first.');
}

type Case = {
	name: string;
	trigger: string;
	kind: string;
	ext: string;
	pick?: string;
	audioOnly?: boolean;
	height?: number;
	subtitles?: string;
};
const cases: Case[] = [
	{ name: 'direct file', trigger: `<video src="/protected/direct.mp4" muted autoplay></video>`, kind: 'file', ext: 'mp4', height: 360 },
	{ name: 'hls master, lower variant', trigger: `<script>fetch('/protected/hls/master.m3u8')</script>`, kind: 'hls', ext: 'mp4', pick: '180', height: 180 },
	{ name: 'hls aes-128', trigger: `<script>fetch('/protected/hls-aes/index.m3u8')</script>`, kind: 'hls', ext: 'mp4', height: 360 },
	{ name: 'hls fmp4, audio only', trigger: `<script>fetch('/protected/hls-fmp4/master.m3u8')</script>`, kind: 'hls', ext: 'm4a', audioOnly: true },
	{
		// The page also loads the subtitle playlist itself, which must not become a second item.
		name: 'hls subtitles',
		trigger: `<script>fetch('/protected/hls-subs/master.m3u8').then(() => fetch('/protected/hls-subs/en.m3u8'))</script>`,
		kind: 'hls',
		ext: 'vtt',
		subtitles: 'English',
	},
	{ name: 'dash', trigger: `<script>fetch('/protected/dash/manifest.mpd')</script>`, kind: 'dash', ext: 'mp4', height: 360 },
];

for (const [index, test] of cases.entries()) {
	writeFileSync(join(fixtures, `page${index}.html`), `<!doctype html><title>Fixture ${index}: ${test.name}</title>${test.trigger}`);
}

const profile = mkdtempSync(join(tmpdir(), 'streamgrab-e2e-'));
const downloads = join(profile, 'downloads');
mkdirSync(downloads);
mkdirSync(shots, { recursive: true });

const server = await serveFixtures(fixtures, 'http://127.0.0.1');
const context = await chromium.launchPersistentContext(profile, {
	channel: 'chromium',
	headless: true,
	acceptDownloads: true,
	downloadsPath: downloads,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
	console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
	if (!condition) {
		failures.push(message);
	}
};

const newestDownload = () => readdirSync(downloads)
	.map(name => join(downloads, name))
	.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

try {
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const extensionId = new URL(worker.url()).host;
	worker.on('console', message => console.error('worker:', message.text()));
	// The worker target exists before its script has run; install-time setup having finished means it is listening.
	while (!await worker.evaluate(async () => 'jobRules' in await chrome.storage.session.get('jobRules'))) {
		await new Promise(done => setTimeout(done, 100));
	}

	const openPopup = async (page: Page): Promise<Page> => {
		const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, page.url());
		const popup = await context.newPage();
		popup.on('pageerror', error => console.error('popup error:', error.message));
		await popup.setViewportSize({ width: 372, height: 420 });
		await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
		return popup;
	};

	for (const [index, test] of cases.entries()) {
		const page = await context.newPage();
		await page.goto(`${server.origin}/page${index}.html`);
		const popup = await openPopup(page);

		const item = popup.getByTestId('media-item');
		await item.first().waitFor({ timeout: 10_000 });
		check(await item.count() === 1, `${test.name}: exactly one item listed`);
		check(await item.first().getAttribute('data-kind') === test.kind, `${test.name}: detected as ${test.kind}`);

		if (test.pick) {
			const select = popup.getByTestId('quality');
			const value = await select.locator('option', { hasText: `${test.pick}p` }).getAttribute('value');
			await select.selectOption(value!);
		}
		const before = server.requests.length;
		if (test.subtitles) {
			await page.waitForTimeout(500);
			check(await item.count() === 1, `${test.name}: subtitle playlist not listed separately`);
			await popup.getByTestId('subtitles').selectOption({ label: test.subtitles });
		} else {
			await popup.getByTestId(test.audioOnly ? 'audio-only' : 'download').click();
		}

		const job = popup.getByTestId('job').first();
		await job.waitFor();
		if (index === 1) {
			await popup.screenshot({ path: join(shots, 'popup-light.png') });
		}
		await popup.locator('[data-testid="job"][data-state="done"], [data-testid="job"][data-state="failed"]').first().waitFor({ timeout: 60_000 });
		const state = await job.getAttribute('data-state');
		check(state === 'done', `${test.name}: job finished (${await popup.getByTestId('job-status').first().textContent()})`);

		const own = server.requests.slice(before).filter(request => request.path.startsWith('/protected/'));
		check(own.length > 0 && own.every(request => request.referer?.startsWith(server.origin)), `${test.name}: referer replayed on ${own.length} requests`);

		if (state === 'done' && test.subtitles) {
			const text = readFileSync(newestDownload()!, 'utf8');
			const cues = text.split('\n\n').filter(block => block.includes('-->'));
			check(text.startsWith('WEBVTT') && cues.length === 3, `${test.name}: merged into ${cues.length} cues without repeats`);
		} else if (state === 'done') {
			const file = newestDownload()!;
			const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString());
			const decodeErrors = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
			const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
			const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
			const duration = Number(probe.format.duration);
			check(decodeErrors === '' && duration > 11.5 && duration < 12.5 && Boolean(audio), `${test.name}: saved file decodes cleanly, ${duration.toFixed(2)}s`);
			check(test.audioOnly ? !video : video?.height === test.height, `${test.name}: ${test.audioOnly ? 'audio only' : `${video?.height}p video`}`);
		}

		if (index === cases.length - 1) {
			await popup.emulateMedia({ colorScheme: 'dark' });
			await popup.screenshot({ path: join(shots, 'popup-dark.png') });
		}
		await popup.getByTestId('clear').first().click();
		await popup.close();
		await page.close();
	}

	const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
	check(rules.length === 0, 'no header rules left behind');
	const listTemporaryFiles = () => worker.evaluate(async () => {
		const names: string[] = [];
		const directory = await navigator.storage.getDirectory();
		for await (const name of (directory as unknown as { keys: () => AsyncIterable<string> }).keys()) {
			names.push(name);
		}
		return names;
	});
	// The file is released just after the job is shown as done, so allow that a moment.
	let leftovers = await listTemporaryFiles();
	for (let attempt = 0; leftovers.length > 0 && attempt < 20; attempt++) {
		await new Promise(done => setTimeout(done, 100));
		leftovers = await listTemporaryFiles();
	}
	check(leftovers.length === 0, 'no temporary files left behind');
} finally {
	await context.close();
	await server.close();
	rmSync(profile, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log('\nall checks passed');
