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

// The yt-dlp bridge is registered inside the throwaway profile and told to save into its own directory.
const bridgeDownloads = join(profile, 'bridge-downloads');
mkdirSync(bridgeDownloads);
execFileSync(process.execPath, [join(root, 'scripts/install-host.mjs'), '--dir', join(profile, 'NativeMessagingHosts'), '--output-dir', bridgeDownloads]);
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
		await popup.setViewportSize({ width: 420, height: 600 });
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

		if (index === 0) {
			await popup.getByTestId('thumbnail').waitFor({ timeout: 20_000 });
			const shown = await popup.getByTestId('thumbnail').evaluate((image: HTMLImageElement) => image.decode().then(() => image.naturalWidth));
			check(shown === 240, `${test.name}: thumbnail decoded from the file (${shown}px wide)`);
			await page.evaluate(() => {
				document.title = '(4) Renamed while open';
			});
			await popup.locator('.title', { hasText: /^Renamed while open$/ }).waitFor({ timeout: 5000 });
			check(true, `${test.name}: title follows the tab and drops the unread counter`);
		} else if (!test.subtitles) {
			const appeared = await popup.getByTestId('thumbnail').waitFor({ timeout: 20_000 }).then(() => true, () => false);
			check(appeared, `${test.name}: thumbnail shown`);
		}

		if (test.pick) {
			await popup.getByTestId('more').click();
		}
		const before = server.requests.length;
		if (test.subtitles) {
			await page.waitForTimeout(500);
			check(await item.count() === 1, `${test.name}: subtitle playlist not listed separately`);
			await popup.getByTestId('more').click();
			await popup.getByTestId('subtitle').filter({ hasText: test.subtitles }).click();
		} else if (test.pick) {
			await popup.locator(`[data-testid="quality"][data-height="${test.pick}"]`).click();
		} else if (test.audioOnly) {
			await popup.getByTestId('more').click();
			await popup.getByTestId('audio-only').click();
		} else {
			await popup.getByTestId('download').click();
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

	// Several items on one page: the list offers sorting and a length filter, and downloads get their own section.
	// The page loads the same HLS video through two different master playlists, which must end up as one item.
	{
		writeFileSync(join(fixtures, 'many.html'), `<!doctype html><title>(2) Several videos</title><video src="/direct.mp4" muted autoplay></video>
			<script>fetch('/hls/master.m3u8'); fetch('/dash/manifest.mpd'); fetch('/hls-subs/master.m3u8')</script>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/many.html`);
		const popup = await openPopup(page);
		const items = popup.getByTestId('media-item');
		await popup.getByTestId('thumbnail').nth(2).waitFor({ timeout: 30_000 });
		await popup.waitForTimeout(1500);
		check(await items.count() === 3 && await popup.getByTestId('sort').isVisible(), `several items: ${await items.count()} listed, the twin playlists merged, sorting offered`);
		check(await popup.getByTestId('subtitle').count() === 1, 'several items: the playlist with subtitles is the one kept');
		const sizes = await popup.getByTestId('size').allTextContents();
		check(sizes.filter(text => /^~?[\d.]+ (KB|MB)$/.test(text)).length >= 3, `several items: sizes shown (${sizes.join(' | ')})`);
		check((await popup.getByTestId('duration').allTextContents()).join() === '0:12,0:12,0:12', 'several items: durations shown on the frames');

		await popup.getByTestId('min-duration').selectOption('60');
		await popup.getByTestId('hidden-note').waitFor();
		check(await items.count() === 0, 'several items: the length filter hides the 12 second fixtures and says so');
		await popup.getByTestId('min-duration').selectOption('0');

		await items.first().getByTestId('download').click();
		await popup.locator('[data-testid="finished-list"] [data-state="done"]').waitFor({ timeout: 60_000 });
		await items.nth(1).getByTestId('more').click();
		await items.nth(1).getByTestId('download').click();
		check(await popup.locator('#tray [data-testid="finished-list"] [data-state="done"]').count() === 1, 'several items: finished downloads sit in the tray, apart from the page list');
		await popup.setViewportSize({ width: 420, height: 600 });
		await popup.screenshot({ path: join(shots, 'popup-many.png') });
		await popup.emulateMedia({ colorScheme: 'dark' });
		await popup.screenshot({ path: join(shots, 'popup-many-dark.png') });
		await popup.locator('[data-testid="finished-list"] [data-state="done"]').nth(1).waitFor({ timeout: 60_000 });
		await popup.getByTestId('clear-finished').click();
		await popup.getByTestId('job').first().waitFor({ state: 'detached' });
		await popup.close();
		await page.close();
	}

	// Media that never shows up as a played file on the network: one fetched whole by a script, and one in a
	// <video> element that has not loaded anything yet. A fragment fetched next to a manifest must stay unlisted.
	{
		writeFileSync(join(fixtures, 'quiet.html'), `<!doctype html><title>Quiet page</title>
			<video src="/hls/v0_000.ts" preload="none"></video><video src="/source.mp4" preload="none"></video>
			<script>fetch('/direct.mp4', { headers: { Range: 'bytes=0-999' } })</script>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/quiet.html`);
		const popup = await openPopup(page);
		const items = popup.getByTestId('media-item');
		await items.nth(2).waitFor({ timeout: 15_000 }).catch(() => {});
		const titles = await popup.locator('.item .shot .tag').allTextContents();
		check(await items.count() === 3, `quiet page: script-fetched file and unplayed elements listed (${titles.join(', ')})`);
		await popup.close();
		await page.close();

		writeFileSync(join(fixtures, 'fragments.html'), `<!doctype html><title>Fragments</title>
			<script>fetch('/hls/master.m3u8').then(() => fetch('/direct.mp4', { headers: { Range: 'bytes=0-999' } }))</script>`);
		const second = await context.newPage();
		await second.goto(`${server.origin}/fragments.html`);
		const secondPopup = await openPopup(second);
		await secondPopup.getByTestId('media-item').first().waitFor();
		await secondPopup.waitForTimeout(1500);
		check(await secondPopup.getByTestId('media-item').count() === 1, 'fragments page: a file fetched beside a manifest is not listed');
		await secondPopup.close();
		await second.close();
	}

	// Picture and sound fetched as two files must show as one item and download as one complete video.
	{
		writeFileSync(join(fixtures, 'split.html'), `<!doctype html><title>Split tracks</title>
			<script>for (const name of ['picture', 'sound']) fetch('/protected/' + name + '.mp4', { headers: { Range: 'bytes=0-999' } })</script>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/split.html`);
		const popup = await openPopup(page);
		const items = popup.getByTestId('media-item');
		await popup.locator('[data-testid="media-item"][data-paired]').waitFor({ timeout: 30_000 }).catch(() => {});
		check(await items.count() === 1, `split tracks: picture and sound shown as one item (${await items.count()})`);
		await popup.getByTestId('download').click();
		await popup.locator('[data-testid="finished-list"] [data-testid="job"]').first().waitFor({ timeout: 60_000 });
		const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', newestDownload()!]).toString());
		const kinds = probe.streams.map((stream: { codec_type: string }) => stream.codec_type).sort().join('+');
		check(kinds === 'audio+video' && Math.abs(Number(probe.format.duration) - 12) < 0.5, `split tracks: saved file has ${kinds}, ${Number(probe.format.duration).toFixed(1)}s`);
		await popup.getByTestId('clear').first().click();
		await popup.close();
		await page.close();
	}

	// A feed: one video plays while the page has loaded others. The playing one is shown and the rest folded away.
	{
		writeFileSync(join(fixtures, 'feed.html'), `<!doctype html><title>Feed</title>
			<video src="/short.mp4" muted autoplay loop></video>
			<script>fetch('/hls/master.m3u8'); fetch('/dash/manifest.mpd')</script>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/feed.html`);
		await page.waitForFunction(() => !document.querySelector('video')!.paused);
		const popup = await openPopup(page);
		await popup.getByTestId('playing').waitFor({ timeout: 30_000 }).catch(() => {});
		const items = popup.getByTestId('media-item');
		check(await items.count() === 1 && await items.first().getAttribute('data-kind') === 'file', `feed: only the playing video is shown (${await items.count()} item)`);
		await popup.getByTestId('others').click();
		check(await items.count() === 3 && await popup.getByTestId('playing').count() === 1, 'feed: the others appear on request, the playing one marked');
		await popup.screenshot({ path: join(shots, 'popup-feed.png') });
		await popup.close();
		await page.close();
	}

	// A page handed to yt-dlp through the native bridge: found on request, downloaded by yt-dlp itself.
	{
		writeFileSync(join(fixtures, 'bridge.html'), '<!doctype html><title>Bridge fixture</title><video src="/direct.mp4" controls></video>');
		const page = await context.newPage();
		await page.goto(`${server.origin}/bridge.html`);
		const popup = await openPopup(page);
		await popup.getByTestId('probe').click();
		const item = popup.locator('[data-testid="media-item"][data-kind="page"]');
		const found = await item.waitFor({ timeout: 60_000 }).then(() => true, () => false);
		check(found, `yt-dlp bridge: page recognised${found ? '' : ` (${await popup.getByTestId('probe-status').textContent().catch(() => 'no status')})`}`);
		if (found) {
			await item.getByTestId('download').click();
			await popup.locator('[data-testid="job"][data-state="done"], [data-testid="job"][data-state="failed"]').first().waitFor({ timeout: 120_000 });
			const state = await popup.getByTestId('job').first().getAttribute('data-state');
			check(state === 'done', `yt-dlp bridge: job finished (${await popup.getByTestId('job-status').first().textContent()})`);
			const saved = readdirSync(bridgeDownloads).filter(name => name.endsWith('.mp4'));
			check(saved.length === 1, `yt-dlp bridge: yt-dlp saved ${saved.join(', ') || 'nothing'}`);
			if (saved[0]) {
				const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', join(bridgeDownloads, saved[0])]).toString());
				check(Math.abs(Number(probe.format.duration) - 12) < 0.5, `yt-dlp bridge: saved file is the ${Number(probe.format.duration).toFixed(1)}s video`);
			}
		}
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
