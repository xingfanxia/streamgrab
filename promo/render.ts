// Renders one promo video frame by frame: opens the built page at the exact output size, steps promoSeek(t) for
// every frame at 30 fps, screenshots each, then encodes with ffmpeg.
//   npx tsx promo/render.ts zh            1080x1440, Simplified Chinese  -> scratch/media/promo/streamgrab-zh-3x4.mp4
//   npx tsx promo/render.ts en            1920x1080, English             -> scratch/media/promo/streamgrab-en-16x9.mp4
//   npx tsx promo/render.ts en --stills 1.5,5,12     only those moments, as PNGs in scratch/media/promo/stills/
// Run `node promo/build.mjs` first.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'scratch/media/promo');
const page = join(out, 'build/promo.html');
if (!existsSync(page)) {
	throw new Error('Run `node promo/build.mjs` first.');
}

const args = process.argv.slice(2);
const lang = args[0] === 'zh' ? 'zh' : 'en';
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const format = option('--format') ?? (lang === 'zh' ? '3x4' : '16x9');
const [width, height] = format === '3x4' ? [1080, 1440] : [1920, 1080];
const fps = 30;
const posterAt = Number(option('--poster') ?? 12);
const stills = option('--stills')?.split(',').map(Number);

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
	const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
	const tab = await context.newPage();
	tab.on('pageerror', error => {
		throw error;
	});
	await tab.goto(`${pathToFileURL(page).href}?lang=${lang}&format=${format}`);
	await tab.evaluate(() => document.fonts.ready);
	await tab.locator('.shot img').evaluate((image: HTMLImageElement) => image.decode());
	const duration: number = await tab.evaluate(() => (window as any).promoDuration);
	const seek = async (t: number) => {
		await tab.evaluate(time => {
			(window as any).promoSeek(time);
		}, t);
	};

	if (stills) {
		mkdirSync(join(out, 'stills'), { recursive: true });
		for (const t of stills) {
			await seek(t);
			const file = join(out, 'stills', `${lang}-${format}-t${t}.png`);
			await tab.screenshot({ path: file });
			console.log('wrote', file);
		}
	} else {
		const frames = join(out, `frames-${lang}`);
		rmSync(frames, { recursive: true, force: true });
		mkdirSync(frames, { recursive: true });
		const total = Math.round(duration * fps);
		for (let index = 0; index < total; index++) {
			await seek(index / fps);
			await tab.screenshot({ path: join(frames, `f${String(index).padStart(4, '0')}.png`) });
			if (index % 100 === 0) {
				console.log(`frame ${index} / ${total}`);
			}
		}
		const name = `streamgrab-${lang}-${format}`;
		const video = join(out, `${name}.mp4`);
		execFileSync('ffmpeg', [
			'-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, 'f%04d.png'),
			'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', '-an', video,
		], { stdio: 'inherit' });
		await seek(posterAt);
		await tab.screenshot({ path: join(out, `${name}-poster.png`) });
		console.log('wrote', video);
		console.log('wrote', join(out, `${name}-poster.png`));
	}
} finally {
	await browser.close();
}
