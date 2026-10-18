// Bundles the extension: three entry points plus the static files.
//   node scripts/build.mjs           the full extension, into dist/
//   node scripts/build.mjs --store   the Chrome Web Store version, into dist-store/: no yt-dlp bridge, nothing offered
//                                    from YouTube, and a manifest without the permissions and `key` only the bridge needs
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const store = process.argv.includes('--store');
const outdir = store ? 'dist-store' : 'dist';

/**
 * Permissions the store version leaves out. `cookies` and `nativeMessaging` serve only the yt-dlp bridge; `tabs` adds
 * nothing there, because every tab address and title the extension reads is already readable through `<all_urls>`.
 */
const STORE_OMITS = ['cookies', 'nativeMessaging', 'tabs'];
/** Popup strings that only the yt-dlp bridge shows. */
const BRIDGE_MESSAGES = ['probe', 'probeRunning', 'probeMissing', 'probeFailed'];

const options = {
	entryPoints: {
		background: 'src/background/index.ts',
		offscreen: 'src/offscreen/index.ts',
		popup: 'src/popup/index.ts',
	},
	outdir,
	bundle: true,
	format: 'esm',
	target: 'chrome121',
	sourcemap: watch ? 'inline' : false,
	define: { __STORE__: String(store) },
	// Drops the branches behind `if (!__STORE__)`, and with them the bridge, from the store bundle. Names and layout
	// stay readable.
	minifySyntax: store,
	logLevel: 'info',
};

const editJson = async (path, edit) => {
	const value = JSON.parse(await readFile(path, 'utf8'));
	edit(value);
	await writeFile(path, `${JSON.stringify(value, null, '\t')}\n`);
};

await rm(outdir, { recursive: true, force: true });
await cp('static', outdir, { recursive: true, filter: source => !source.endsWith('.svg') });
await cp(
	'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2',
	`${outdir}/fonts/bricolage-grotesque.woff2`,
);

if (store) {
	// The `key` only pins the extension ID that the native host allows; the store assigns its own ID.
	await editJson(`${outdir}/manifest.json`, manifest => {
		delete manifest.key;
		manifest.permissions = manifest.permissions.filter(permission => !STORE_OMITS.includes(permission));
	});
	for (const locale of ['en', 'zh_CN']) {
		await editJson(`${outdir}/_locales/${locale}/messages.json`, messages => {
			for (const key of BRIDGE_MESSAGES) {
				delete messages[key];
			}
		});
	}
}

if (watch) {
	await (await context(options)).watch();
} else {
	await build(options);
}
