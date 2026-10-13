// End-to-end check: loads the built extension into Chromium, lets it detect the local fixtures on a page, downloads
// each through the popup UI and verifies the saved files with ffprobe. Run via `npm run e2e`.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
		await popup.getByTestId('others').click();
		await page.evaluate(() => document.querySelector('video')!.pause());
		await popup.getByTestId('playing').filter({ hasText: 'On screen' }).waitFor({ timeout: 10_000 }).catch(() => {});
		check(await items.count() === 1 && await popup.getByTestId('playing').textContent() === 'On screen', 'feed: a paused video is still the current one');
		await popup.screenshot({ path: join(shots, 'popup-feed.png') });
		await popup.close();
		await page.close();
	}

	// The tab title says nothing about one video on a profile page; its own title is overlaid on the picture.
	{
		writeFileSync(join(fixtures, 'overlay.html'), `<!doctype html><title>Someone's profile</title>
			<style>.player { position: relative; width: 640px; height: 360px } video { width: 100%; height: 100% } .info { position: absolute; left: 8px; bottom: 8px; color: white }</style>
			<div class="player"><div><video src="/short.mp4" muted autoplay loop></video><div class="info" style="top: 8px; bottom: auto">Resumed at 16:59</div></div>
				<div class="info"><div>@someone</div><div>3 days ago</div><div>Episode 12: why the machine never stops</div><div>A much longer line of description text that carries on well past the headline above it.</div></div>
				<div class="bullet">short</div></div>
			<p>An unrelated and considerably longer paragraph elsewhere on the page, such as a comment, which must not be mistaken for the title of the video that is playing.</p>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/overlay.html`);
		await page.waitForFunction(() => !document.querySelector('video')!.paused);
		const popup = await openPopup(page);
		const title = popup.locator('.item .title', { hasText: 'Episode 12: why the machine never stops' });
		const found = await title.waitFor({ timeout: 20_000 }).then(() => true, () => false);
		check(found, `overlay title: taken from the text over the video (${await popup.locator('.item .title').first().textContent()})`);
		await popup.getByTestId('download').click();
		await popup.locator('[data-testid="finished-list"] [data-testid="job"]').first().waitFor({ timeout: 60_000 });
		const name = await popup.locator('[data-testid="finished-list"] .title').first().textContent();
		check(name === 'Episode 12 why the machine never stops.mp4', `overlay title: used for the saved file (${name})`);
		await popup.getByTestId('clear').first().click();
		await popup.close();
		await page.close();
	}

	// Several items needing the Referer are looked into at the same time; each must still get its header.
	{
		writeFileSync(join(fixtures, 'guarded.html'), `<!doctype html><title>Guarded</title>
			<script>for (const path of ['hls/master.m3u8', 'hls-aes/index.m3u8', 'dash/manifest.mpd', 'hls-fmp4/master.m3u8']) fetch('/protected/' + path)</script>
			<video src="/protected/short.mp4" muted autoplay loop></video>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/guarded.html`);
		const popup = await openPopup(page);
		await popup.getByTestId('others').click({ timeout: 30_000 }).catch(() => {});
		// The three HLS playlists are the same 12 second video and merge into one, leaving HLS, DASH and the file.
		await popup.waitForFunction(() => (
			document.querySelectorAll('[data-testid="media-item"]').length === 3 && document.querySelectorAll('[data-testid="thumbnail"]').length === 3
		), null, { timeout: 30_000 }).catch(() => {});
		const [listed, shown] = [await popup.getByTestId('media-item').count(), await popup.getByTestId('thumbnail').count()];
		check(listed === 3 && shown === 3, `guarded items: looked into at the same time, each with the Referer replayed (${shown} thumbnails for ${listed} items)`);
		await popup.close();
		await page.close();
	}

	// A site that offers each quality as its own playlist: one item, the qualities inside it. Two downloads from
	// the same server take turns rather than running together.
	{
		writeFileSync(join(fixtures, 'qualities.html'), `<!doctype html><title>One video, two playlists</title>
			<script>fetch('/hls/v0.m3u8'); fetch('/hls/v1.m3u8')</script>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/qualities.html`);
		const popup = await openPopup(page);
		const items = popup.getByTestId('media-item');
		await popup.waitForFunction(() => document.querySelectorAll('[data-testid="quality"]').length === 2, null, { timeout: 30_000 }).catch(() => {});
		const heights = await popup.getByTestId('quality').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.height).join());
		check(await items.count() === 1 && heights === '360,180', `per-quality playlists: one item offering ${heights}`);

		await popup.getByTestId('more').click();
		await popup.locator('[data-testid="quality"][data-height="180"]').click();
		await popup.getByTestId('download').click();
		const waiting = await popup.locator('[data-testid="job"][data-state="queued"]').waitFor({ timeout: 5000 }).then(() => true, () => false);
		await popup.waitForFunction(() => document.querySelectorAll('[data-testid="finished-list"] [data-state="done"]').length === 2, null, { timeout: 90_000 }).catch(() => {});
		const done = await popup.locator('[data-testid="finished-list"] [data-state="done"]').count();
		check(done === 2, `same-server downloads: both finished${waiting ? ', the second after waiting its turn' : ''} (${done} of 2)`);
		const saved = readdirSync(downloads).map(name => join(downloads, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 2);
		const savedHeights = saved.map(file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=height', '-of', 'json', file]).toString()).streams[0].height).sort().join();
		check(savedHeights === '180,360', `per-quality playlists: each download came from its own playlist (${savedHeights})`);
		await popup.getByTestId('clear-finished').click();
		await popup.close();
		await page.close();
	}

	// Six slow downloads from one server: five run, the sixth waits and can be cancelled at once.
	{
		const names = ['a', 'b', 'c', 'd', 'e', 'f'].map(letter => `clip-${letter}.mp4`);
		for (const name of names) {
			cpSync(join(fixtures, 'short.mp4'), join(fixtures, name));
		}
		writeFileSync(join(fixtures, 'six.html'), `<!doctype html><title>Six slow ones</title>
			${names.map(name => `<video src="/slow/${name}" preload="none"></video>`).join('')}`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/six.html`);
		const popup = await openPopup(page);
		const buttons = popup.getByTestId('download');
		await buttons.nth(5).waitFor({ timeout: 20_000 });
		for (let index = 0; index < 6; index++) {
			await buttons.nth(index).click();
		}
		const queued = popup.locator('[data-testid="job"][data-state="queued"]');
		const counts = () => popup.evaluate(() => ['running', 'queued', 'canceled'].map(state => document.querySelectorAll(`[data-testid="job"][data-state="${state}"]`).length).join('/'));
		await popup.waitForFunction(() => document.querySelectorAll('[data-testid="job"][data-state="running"]').length === 5 && document.querySelectorAll('[data-testid="job"][data-state="queued"]').length === 1, null, { timeout: 15_000 }).catch(() => {});
		check(await counts() === '5/1/0', `slow server: five transfers run and the sixth waits its turn (${await counts()} running/waiting/cancelled)`);
		await queued.getByTestId('stop').click();
		await popup.locator('[data-testid="job"][data-state="canceled"]').waitFor({ timeout: 3000 }).catch(() => {});
		check(await counts() === '5/0/1', `slow server: the waiting one is cancelled at once, the others carry on (${await counts()})`);
		await popup.waitForFunction(() => document.querySelectorAll('[data-testid="finished-list"] [data-state="done"]').length === 5, null, { timeout: 90_000 }).catch(() => {});
		check(await popup.locator('[data-testid="finished-list"] [data-state="done"]').count() === 5, 'slow server: all five running transfers finish');
		await popup.getByTestId('clear-finished').click();
		await popup.close();
		await page.close();
	}

	// A server that cuts off a second simultaneous transfer: the cut one goes back in line and still completes.
	{
		writeFileSync(join(fixtures, 'capped.html'), `<!doctype html><title>One at a time</title>
			<video src="/capped/direct.mp4" preload="none"></video><video src="/capped/picture.mp4" preload="none"></video>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/capped.html`);
		const popup = await openPopup(page);
		const buttons = popup.getByTestId('download');
		await buttons.nth(1).waitFor({ timeout: 20_000 });
		await buttons.nth(0).click();
		await popup.locator('[data-testid="job"][data-state="running"]').waitFor();
		await popup.waitForTimeout(1500);
		await buttons.nth(1).click();
		await popup.waitForFunction(() => document.querySelectorAll('[data-testid="finished-list"] [data-testid="job"]').length === 2, null, { timeout: 150_000 }).catch(() => {});
		const states = await popup.locator('[data-testid="finished-list"] [data-testid="job"]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.state).join());
		const errors = await popup.getByTestId('job-error').allTextContents();
		check(states === 'done,done', `one-at-a-time server: the cut transfer went back in line and both completed (${states}${errors.length ? `: ${errors.join(' | ')}` : ''})`);
		const sizes = readdirSync(downloads).map(name => join(downloads, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 2).map(file => statSync(file).size).sort().join();
		const expected = ['direct.mp4', 'picture.mp4'].map(name => statSync(join(fixtures, name)).size).sort().join();
		check(sizes === expected, `one-at-a-time server: both files are complete (${sizes})`);
		await popup.getByTestId('clear-finished').click().catch(() => {});
		await popup.close();
		await page.close();
	}

	// A failed download says why in full and offers the record of its requests, with no query strings in it.
	{
		writeFileSync(join(fixtures, 'vanishing.html'), '<!doctype html><title>Vanishing</title><video src="/gone.mp4?token=secret123" preload="none"></video>');
		const page = await context.newPage();
		await page.goto(`${server.origin}/vanishing.html`);
		const popup = await openPopup(page);
		await popup.getByTestId('download').click({ timeout: 15_000 });
		await popup.getByTestId('job-error').waitFor({ timeout: 30_000 });
		const reason = await popup.getByTestId('job-error').textContent();
		const details: string = await worker.evaluate(async () => {
			const state = (await chrome.storage.session.get('state')).state as { jobs: Record<string, { details?: string }> };
			return Object.values(state.jobs).map(job => job.details).find(Boolean) ?? '';
		});
		const parsed = JSON.parse(details.slice(details.indexOf('{')) || '{}') as { requests?: { status?: number }[] };
		check(Boolean(reason?.includes('404')) && parsed.requests?.[0]?.status === 404 && !details.includes('secret123'), `failed download: reason shown in full (${reason}), details recorded without the query string`);
		await popup.getByTestId('clear').first().click();
		await popup.close();
		await page.close();
	}

	// A subtitle track saved as a transcript: plain text, the cue repeated across segments kept once, and copyable.
	{
		writeFileSync(join(fixtures, 'spoken.html'), `<!doctype html><title>Spoken</title><script>fetch('/hls-subs/master.m3u8')</script>`);
		const page = await context.newPage();
		await page.goto(`${server.origin}/spoken.html`);
		const popup = await openPopup(page);
		await popup.getByTestId('more').click({ timeout: 20_000 });
		await popup.getByTestId('transcript').filter({ hasText: 'English' }).click();
		await popup.locator('[data-testid="finished-list"] [data-testid="job"]').first().waitFor({ timeout: 30_000 });
		const name = await popup.locator('[data-testid="finished-list"] .title').first().textContent();
		const saved = readFileSync(newestDownload()!, 'utf8');
		check(name === 'Spoken.English.txt' && saved === 'first line spans the boundary last line\n', `transcript: saved as ${name} with the text "${saved.trim()}"`);
		check(await popup.getByTestId('copy-text').count() === 1, 'transcript: offered for copying from the list');
		await popup.getByTestId('clear').first().click();
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
