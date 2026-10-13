// Bundles the extension into dist/: three entry points plus the static files.
import { cp, rm } from 'node:fs/promises';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
	entryPoints: {
		background: 'src/background/index.ts',
		offscreen: 'src/offscreen/index.ts',
		popup: 'src/popup/index.ts',
	},
	outdir: 'dist',
	bundle: true,
	format: 'esm',
	target: 'chrome121',
	sourcemap: watch ? 'inline' : false,
	logLevel: 'info',
};

await rm('dist', { recursive: true, force: true });
await cp('static', 'dist', { recursive: true, filter: source => !source.endsWith('.svg') });
await cp(
	'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2',
	'dist/fonts/bricolage-grotesque.woff2',
);

if (watch) {
	await (await context(options)).watch();
} else {
	await build(options);
}
