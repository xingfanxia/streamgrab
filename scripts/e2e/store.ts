// Checks the Chrome Web Store build in dist-store/: its manifest and bundles carry nothing of the yt-dlp bridge, it
// loads into Chromium, saves a fixture through the popup, and offers nothing from YouTube. Run via `npm run e2e:store`.
// YouTube is never contacted: its addresses are answered from the fixtures by Playwright inside the browser.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { serveFixtures } from '../../tests/serve';

const root = resolve(import.meta.dirname, '../..');
const fixtures = join(root, 'scratch/data/fixtures');
const extension = join(root, 'dist-store');

if (!existsSync(join(fixtures, 'direct.mp4'))) {
	throw new Error('Fixtures are missing; run `npm run fixtures` first.');
}

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
	console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
	if (!condition) {
		failures.push(message);
	}
};

const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
check(!('key' in manifest), 'manifest: no key');
const permissions: string[] = manifest.permissions;
check(!['nativeMessaging', 'cookies', 'tabs'].some(name => permissions.includes(name)), `manifest: permissions are ${permissions.join(', ')}`);
const bundles = ['background.js', 'popup.js', 'offscreen.js'].map(name => readFileSync(join(extension, name), 'utf8')).join('\n');
check(!/connectNative|chrome\.cookies|yt-dlp/.test(bundles), 'bundles: no trace of the yt-dlp bridge');
for (const locale of ['en', 'zh_CN']) {
	const messages = JSON.parse(readFileSync(join(extension, `_locales/${locale}/messages.json`), 'utf8'));
	check(!('probe' in messages) && Boolean(messages.noYouTube?.message), `${locale} messages: bridge strings left out, YouTube note present`);
}

const profile = mkdtempSync(join(tmpdir(), 'streamgrab-store-'));
const downloads = join(profile, 'downloads');
mkdirSync(downloads);
const server = await serveFixtures(fixtures);
const context = await chromium.launchPersistentContext(profile, {
	channel: 'chromium',
	headless: true,
	acceptDownloads: true,
	downloadsPath: downloads,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

// Pages on these hosts are served from the fixtures by Playwright, so the browser believes it is on them.
const page = (body: string) => `<!doctype html>${body}`;
const served: Record<string, string> = {
	'https://www.youtube.com/watch?v=fixture': page(`<title>A video - YouTube</title><video src="/v/direct.mp4" muted autoplay></video>`),
	'https://media.example/watch': page(`<title>Media example</title><video src="/v/direct.mp4" muted autoplay></video>`),
	'https://media.example/embed': page(`<title>Embedded</title><video src="/v/direct.mp4" preload="none"></video>
		<video src="https://rr1---sn-fixture.googlevideo.com/videoplayback?itag=18" preload="none"></video>`),
};
await context.route(/^https:\/\/(www\.youtube\.com|media\.example|[\w-]+\.googlevideo\.com)\//, async route => {
	const url = route.request().url();
	if (served[url]) {
		await route.fulfill({ contentType: 'text/html', body: served[url] });
	} else if (new URL(url).pathname.endsWith('.mp4') || url.includes('videoplayback')) {
		await route.fulfill({ contentType: 'video/mp4', body: readFileSync(join(fixtures, 'direct.mp4')) });
	} else {
		await route.abort();
	}
});

try {
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const extensionId = new URL(worker.url()).host;
	const workerErrors: string[] = [];
	worker.on('console', message => {
		if (message.type() === 'error') {
			workerErrors.push(message.text());
		}
	});
	while (!await worker.evaluate(async () => 'jobRules' in await chrome.storage.session.get('jobRules'))) {
		await new Promise(done => setTimeout(done, 100));
	}
	const running = await worker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
	check(running.join() === permissions.join(), `service worker started with the store manifest (${extensionId})`);

	const openPopup = async (tab: Page): Promise<Page> => {
		const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, tab.url());
		const popup = await context.newPage();
		popup.on('pageerror', error => console.error('popup error:', error.message));
		await popup.setViewportSize({ width: 420, height: 600 });
		await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
		return popup;
	};
	const newestDownload = () => readdirSync(downloads).map(name => join(downloads, name))[0];

	// An ordinary page: found, named after the tab, and saved through the popup like in the full build.
	{
		writeFileSync(join(fixtures, 'store.html'), '<!doctype html><title>Store fixture</title><video src="/protected/direct.mp4" muted autoplay></video>');
		const tab = await context.newPage();
		await tab.goto(`${server.origin}/store.html`);
		const popup = await openPopup(tab);
		await popup.getByTestId('media-item').first().waitFor({ timeout: 15_000 });
		check(await popup.locator('.item .title').first().textContent() === 'Store fixture', 'ordinary page: item listed under the tab title');
		check(await popup.getByTestId('probe').count() === 0 && await popup.locator('#probe').isHidden(), 'ordinary page: no yt-dlp line in the popup');
		await popup.getByTestId('download').click();
		await popup.locator('[data-testid="finished-list"] [data-testid="job"]').first().waitFor({ timeout: 60_000 });
		const state = await popup.locator('[data-testid="finished-list"] [data-testid="job"]').first().getAttribute('data-state');
		const file = newestDownload();
		const duration = file ? Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', file]).toString()).format.duration) : 0;
		check(state === 'done' && Math.abs(duration - 12) < 0.5, `ordinary page: saved (${state}, ${duration.toFixed(1)}s)`);
		await popup.close();
		await tab.close();
	}

	// The same page on another https host is listed, so what follows is down to the rule and not to the setup.
	{
		const tab = await context.newPage();
		await tab.goto('https://media.example/watch');
		const popup = await openPopup(tab);
		const listed = await popup.getByTestId('media-item').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
		check(listed, 'served https page: its video is listed');
		await popup.close();
		await tab.close();
	}

	// A YouTube tab: nothing listed, no badge, and the popup says why.
	{
		const tab = await context.newPage();
		await tab.goto('https://www.youtube.com/watch?v=fixture');
		await tab.waitForFunction(() => !document.querySelector('video')!.paused).catch(() => {});
		const popup = await openPopup(tab);
		await popup.waitForTimeout(3000);
		const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, tab.url());
		const stored = await worker.evaluate(async id => Object.keys(((await chrome.storage.session.get('state')).state as { media: Record<string, object> } | undefined)?.media[id] ?? {}).length, tabId);
		const badge = await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId);
		check(await popup.getByTestId('media-item').count() === 0 && stored === 0 && badge === '', `YouTube tab: nothing listed or stored (${stored} stored, badge "${badge}")`);
		const note = popup.locator('[data-testid="empty"][data-reason="youtube"]');
		check(await note.isVisible() && (await note.textContent())!.includes("YouTube isn't supported"), `YouTube tab: note shown (${(await popup.locator('#empty').textContent())?.trim()})`);
		await popup.close();
		await tab.close();
	}

	// YouTube's stream embedded in another page is left out; the page's own video is still offered.
	{
		const tab = await context.newPage();
		await tab.goto('https://media.example/embed');
		const popup = await openPopup(tab);
		await popup.getByTestId('media-item').first().waitFor({ timeout: 15_000 }).catch(() => {});
		await popup.waitForTimeout(2000);
		const urls = await worker.evaluate(async () => Object.values(((await chrome.storage.session.get('state')).state as { media: Record<string, Record<string, { url: string }>> }).media).flatMap(items => Object.values(items).map(item => item.url)));
		check(await popup.getByTestId('media-item').count() === 1 && !urls.some(url => url.includes('googlevideo')), `embedded googlevideo stream: left out, the page's own video listed (${await popup.getByTestId('media-item').count()} item)`);
		await popup.close();
		await tab.close();
	}

	check(workerErrors.length === 0, `service worker logged no errors${workerErrors.length ? `: ${workerErrors.join(' | ')}` : ''}`);
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
