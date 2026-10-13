// Stills and close-ups of the standalone figure, for checking it by eye.
//   npx tsx promo/shots.ts <name> <t> [x,y,w,h in viewBox units] [--light] [--scale 4]
// Writes scratch/media/promo/stills/<name>.png. Run `node promo/build.mjs` first.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'scratch/media/promo/stills');
const args = process.argv.slice(2);
const flags = args.filter(arg => arg.startsWith('--'));
const [name, time, region] = args.filter((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--scale'));
const scale = args.includes('--scale') ? Number(args[args.indexOf('--scale') + 1]) : region ? 4 : 2;
const file = flags.includes('--light') ? 'figure-light.html' : 'figure.html';

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
	const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: scale })).newPage();
	page.on('pageerror', error => console.error('page error:', error.message));
	await page.goto(pathToFileURL(join(root, 'scratch/media/promo/build', file)).href);
	await page.evaluate(t => {
		(window as any).promoSeek(t);
	}, Number(time));
	const svg = page.locator('.iso-svg');
	const box = (await svg.boundingBox())!;
	const view = await svg.evaluate((node: SVGSVGElement) => [node.viewBox.baseVal.width, node.viewBox.baseVal.height]);
	const unit = box.width / view[0];
	const [x, y, w, h] = region ? region.split(',').map(Number) : [0, 0, view[0], view[1]];
	const target = join(out, `${name}.png`);
	await page.screenshot({ path: target, clip: { x: box.x + x * unit, y: box.y + y * unit, width: w * unit, height: h * unit } });
	console.log('wrote', target, await page.locator('[data-readout]').textContent());
} finally {
	await browser.close();
}
