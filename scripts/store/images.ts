// Makes the Chrome Web Store images in docs/store/ from the store build's real popup:
//   screenshot-1-list.png, screenshot-2-quality.png  1280x800
//   promo-small.png                                  440x280
// The popup is captured at 2x on the local fixtures (colour bars), served under the reserved name `media.example`
// so the popup shows a plain host rather than a loopback address and port.
// Run: npx tsx scripts/store/images.ts   (needs `npm run build:store` and `npm run fixtures` first; ffmpeg on the path)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { serveFixtures } from '../../tests/serve';

const root = resolve(import.meta.dirname, '../..');
const fixtures = join(root, 'scratch/data/fixtures');
const extension = join(root, 'dist-store');
const work = join(root, 'scratch/media/store');
const out = join(root, 'docs/store');

if (!existsSync(join(fixtures, 'direct.mp4')) || !existsSync(join(extension, 'manifest.json'))) {
	throw new Error('Run `npm run build:store` and `npm run fixtures` first.');
}
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

const dataUrl = (path: string, type: string) => `data:${type};base64,${readFileSync(path).toString('base64')}`;

// --- 1. The popup, twice ------------------------------------------------------------------------------------------

const server = await serveFixtures(fixtures);
const port = new URL(server.origin).port;
const profile = mkdtempSync(join(tmpdir(), 'streamgrab-store-images-'));
const context: BrowserContext = await chromium.launchPersistentContext(profile, {
	channel: 'chromium',
	headless: true,
	acceptDownloads: true,
	downloadsPath: join(profile, 'downloads'),
	deviceScaleFactor: 2,
	viewport: { width: 420, height: 600 },
	args: [
		`--disable-extensions-except=${extension}`,
		`--load-extension=${extension}`,
		`--host-resolver-rules=MAP media.example:80 127.0.0.1:${port}`,
	],
});

const site = 'http://media.example';
const pageTitle = 'Sample streams';

try {
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const extensionId = new URL(worker.url()).host;
	while (!await worker.evaluate(async () => 'jobRules' in await chrome.storage.session.get('jobRules'))) {
		await new Promise(done => setTimeout(done, 100));
	}
	const openPopup = async (tab: Page, dark: boolean) => {
		const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0]!.id!, tab.url());
		const popup = await context.newPage();
		await popup.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
		await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
		return popup;
	};
	// A real popup is as tall as its content, so the capture stops where the content does.
	const capture = async (popup: Page, file: string) => {
		const height = await popup.evaluate(() => Math.ceil(Math.max(...['header', 'main', '#tray'].map(selector => document.querySelector(selector)!.getBoundingClientRect().bottom))));
		await popup.screenshot({ path: join(work, file), clip: { x: 0, y: 0, width: 420, height: Math.min(600, height) } });
	};

	// Several videos on one page, one of them already saved.
	writeFileSync(join(fixtures, 'store-list.html'), `<!doctype html><title>${pageTitle}</title><video src="/direct.mp4" muted autoplay></video>
		<script>fetch('/hls/master.m3u8'); fetch('/dash/manifest.mpd'); fetch('/hls-subs/master.m3u8')</script>`);
	{
		const tab = await context.newPage();
		await tab.goto(`${site}/store-list.html`);
		const popup = await openPopup(tab, false);
		const items = popup.getByTestId('media-item');
		await popup.getByTestId('thumbnail').nth(2).waitFor({ timeout: 30_000 });
		await popup.waitForTimeout(1500);
		await items.last().getByTestId('download').click();
		await popup.locator('[data-testid="finished-list"] [data-state="done"]').waitFor({ timeout: 60_000 });
		await popup.mouse.move(0, 0);
		await popup.waitForTimeout(300);
		await capture(popup, 'popup-list.png');
		await popup.close();
		await tab.close();
	}

	// One stream's other ways to save it open, and a download from a slow server under way.
	writeFileSync(join(fixtures, 'store-quality.html'), `<!doctype html><title>${pageTitle}</title>
		<script>fetch('/hls/master.m3u8'); fetch('/hls-subs/master.m3u8')</script><video src="/slow/direct.mp4" preload="none"></video>`);
	{
		const tab = await context.newPage();
		await tab.goto(`${site}/store-quality.html`);
		const popup = await openPopup(tab, true);
		const stream = popup.locator('[data-testid="media-item"][data-kind="hls"]');
		await stream.getByTestId('thumbnail').waitFor({ timeout: 30_000 });
		await popup.waitForFunction(() => document.querySelectorAll('[data-testid="thumbnail"]').length === 2, null, { timeout: 30_000 });
		await popup.waitForTimeout(1500);
		await popup.locator('[data-testid="media-item"][data-kind="file"]').getByTestId('download').click();
		await stream.getByTestId('more').click();
		await popup.waitForFunction(() => {
			const status = document.querySelector('[data-testid="job"][data-state="running"] [data-testid="job-status"]')?.textContent ?? '';
			const percent = Number(/^(\d+)%/.exec(status)?.[1] ?? 0);
			return percent >= 35 && percent <= 70;
		}, null, { timeout: 30_000, polling: 50 });
		await popup.mouse.move(0, 0);
		await capture(popup, 'popup-quality.png');
		await popup.close();
		await tab.close();
	}
} finally {
	await context.close();
	await server.close();
	rmSync(profile, { recursive: true, force: true });
}

// --- 2. The compositions ------------------------------------------------------------------------------------------

// A frame of the fixture video stands in for the page that is playing it.
const frame = join(work, 'frame.jpg');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '4', '-i', join(fixtures, 'direct.mp4'), '-frames:v', '1', '-q:v', '2', frame]);

const font = dataUrl(join(root, 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2'), 'font/woff2');
const icon = readFileSync(join(root, 'static/icons/icon.svg'), 'utf8');
const iconUrl = `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}`;

/** The popup's own colours (static/popup.css), light and dark. */
const rooms = {
	light: { room: '#f1f0f5', wall: '#ffffff', ink: '#1a1724', soft: '#625d70', rule: '#dedbe6', chrome: '#e6e3ee' },
	dark: { room: '#14121b', wall: '#1d1a27', ink: '#f1f0f5', soft: '#a8a3b8', rule: '#2c283a', chrome: '#262233' },
};

const screenshot = (theme: keyof typeof rooms, headline: string, line: string, popup: string) => {
	const c = rooms[theme];
	return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Bricolage Grotesque"; font-weight: 200 800; src: url(${font}) format("woff2"); }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1280px; height: 800px; overflow: hidden; }
body { background: ${c.room}; color: ${c.ink}; font-family: "Avenir Next", system-ui, sans-serif; position: relative; }
.copy { position: absolute; left: 64px; top: 0; bottom: 0; width: 380px; display: flex; flex-direction: column; justify-content: center; }
.mark { display: flex; align-items: center; gap: 12px; font: 700 22px/1 "Bricolage Grotesque"; margin-bottom: 56px; }
.mark img { width: 36px; height: 36px; }
h1 { font: 750 50px/1.02 "Bricolage Grotesque"; letter-spacing: -0.025em; font-variation-settings: "wdth" 85; }
p { margin-top: 24px; font-size: 20px; line-height: 1.45; color: ${c.soft}; max-width: 360px; }
.window { position: absolute; left: 488px; top: 64px; width: 860px; height: 820px; border-radius: 14px; background: ${c.wall};
	border: 1px solid ${c.rule}; box-shadow: 0 30px 80px -30px rgba(20, 18, 27, ${theme === 'dark' ? 0.9 : 0.28}); overflow: hidden; }
.bar { height: 52px; background: ${c.chrome}; display: flex; align-items: center; padding: 0 18px; gap: 14px; }
.dots { display: flex; gap: 7px; } .dots i { width: 11px; height: 11px; border-radius: 50%; background: ${c.rule}; }
.address { flex: 0 1 430px; height: 30px; border-radius: 15px; background: ${c.wall}; color: ${c.soft}; font-size: 14px; display: flex; align-items: center; padding: 0 16px; }
.button { position: absolute; left: 696px; top: 11px; width: 30px; height: 30px; border-radius: 8px; background: ${c.wall}; display: grid; place-items: center; }
.button img { width: 20px; height: 20px; }
.video { position: absolute; left: 32px; top: 84px; width: 560px; aspect-ratio: 16 / 9; border-radius: 6px; background: url(${dataUrl(frame, 'image/jpeg')}) center / cover; }
.lines { position: absolute; left: 32px; top: 424px; width: 560px; }
.lines i { display: block; height: 12px; border-radius: 6px; background: ${c.chrome}; margin-bottom: 14px; }
.popup { position: absolute; left: 796px; top: 120px; width: 420px; border-radius: 10px; overflow: hidden;
	box-shadow: 0 0 0 1px ${c.rule}, 0 24px 60px -12px rgba(20, 18, 27, ${theme === 'dark' ? 0.85 : 0.35}); }
.popup img { display: block; width: 100%; }
</style></head><body>
<div class="copy">
	<div class="mark"><img src="${iconUrl}" alt="">streamgrab</div>
	<h1>${headline}</h1>
	<p>${line}</p>
</div>
<div class="window">
	<div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="address">media.example/sample-streams</span></div>
	<span class="button"><img src="${iconUrl}" alt=""></span>
	<div class="video"></div>
	<div class="lines"><i style="width: 70%"></i><i style="width: 46%"></i><i style="width: 58%"></i></div>
</div>
<div class="popup"><img src="${dataUrl(join(work, popup), 'image/png')}" alt=""></div>
</body></html>`;
};

const tile = () => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Bricolage Grotesque"; font-weight: 200 800; src: url(${font}) format("woff2"); }
* { box-sizing: border-box; margin: 0; }
html, body { width: 440px; height: 280px; overflow: hidden; }
body { background: #14121b; color: #f1f0f5; font-family: "Avenir Next", system-ui, sans-serif; position: relative; }
.strip { position: absolute; left: 0; right: 0; top: 34px; display: flex; gap: 10px; transform: translateX(-26px); }
.strip i { flex: none; width: 74px; height: 42px; border-radius: 6px; background: #262233; }
.strip i.on { background: #f7c531; }
.icon { position: absolute; left: 40px; top: 112px; width: 84px; height: 84px; }
h1 { position: absolute; left: 144px; top: 118px; font: 750 46px/1 "Bricolage Grotesque"; letter-spacing: -0.03em; font-variation-settings: "wdth" 85; }
p { position: absolute; left: 146px; top: 172px; font-size: 16px; color: #a8a3b8; }
</style></head><body>
<div class="strip"><i></i><i></i><i></i><i class="on"></i><i></i><i></i></div>
<img class="icon" src="${iconUrl}" alt="">
<h1>streamgrab</h1>
<p>Save the video a page is playing</p>
</body></html>`;

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
	const render = async (html: string, width: number, height: number, file: string) => {
		const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
		const source = join(work, file.replace('.png', '.html'));
		writeFileSync(source, html);
		await page.goto(`file://${source}`);
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({ path: join(out, file) });
		await page.close();
		console.log('wrote', join('docs/store', file));
	};
	await render(screenshot('light', 'Save the video this page is playing.', 'Direct files, HLS and DASH streams, saved as MP4 without re-encoding.', 'popup-list.png'), 1280, 800, 'screenshot-1-list.png');
	await render(screenshot('dark', 'Pick a quality, or keep only the sound.', 'Every quality the stream offers, audio on its own, and subtitles as a file or a transcript.', 'popup-quality.png'), 1280, 800, 'screenshot-2-quality.png');
	await render(tile(), 440, 280, 'promo-small.png');
} finally {
	await browser.close();
}
