// Captures the real popup at 2x device pixels for the promo video. It follows the "several items" case of
// scripts/e2e/run.ts: the built extension, the local colour-bar fixtures, one finished download in the tray.
// Run: npx tsx promo/capture-popup.ts   (needs `npm run build` and `npm run fixtures` to have been run)
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveFixtures } from '../tests/serve';

const root = resolve(import.meta.dirname, '..');
const fixtures = join(root, 'scratch/data/fixtures');
const out = join(root, 'scratch/media/promo');
const extension = join(root, 'dist');

if (!existsSync(join(fixtures, 'direct.mp4')) || !existsSync(join(extension, 'manifest.json'))) {
	throw new Error('Run `npm run build` and `npm run fixtures` first.');
}
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'streamgrab-promo-'));
const downloads = join(profile, 'downloads');
mkdirSync(downloads);

const server = await serveFixtures(fixtures, 'http://127.0.0.1');
const context = await chromium.launchPersistentContext(profile, {
	channel: 'chromium',
	headless: true,
	acceptDownloads: true,
	downloadsPath: downloads,
	deviceScaleFactor: 2,
	viewport: { width: 420, height: 600 },
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const extensionId = new URL(worker.url()).host;
	while (!await worker.evaluate(async () => 'jobRules' in await chrome.storage.session.get('jobRules'))) {
		await new Promise(done => setTimeout(done, 100));
	}

	writeFileSync(join(fixtures, 'many.html'), `<!doctype html><title>Several videos</title><video src="/direct.mp4" muted autoplay></video>
		<script>fetch('/hls/master.m3u8'); fetch('/dash/manifest.mpd'); fetch('/hls-subs/master.m3u8')</script>`);
	const page = await context.newPage();
	await page.goto(`${server.origin}/many.html`);
	const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, page.url());
	const popup = await context.newPage();
	await popup.setViewportSize({ width: 420, height: 600 });
	await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);

	const items = popup.getByTestId('media-item');
	await popup.getByTestId('thumbnail').nth(2).waitFor({ timeout: 30_000 });
	await popup.waitForTimeout(1500);
	await items.first().getByTestId('download').click();
	await popup.locator('[data-testid="finished-list"] [data-state="done"]').waitFor({ timeout: 60_000 });
	await items.nth(1).getByTestId('more').click();
	await popup.waitForTimeout(400);
	await popup.mouse.move(400, 590);
	await popup.emulateMedia({ colorScheme: 'dark' });
	await popup.waitForTimeout(300);
	await popup.screenshot({ path: join(out, 'popup-many-dark@2x.png') });
	console.log('wrote', join(out, 'popup-many-dark@2x.png'));
} finally {
	await context.close();
	await server.close?.();
	rmSync(profile, { recursive: true, force: true });
}
