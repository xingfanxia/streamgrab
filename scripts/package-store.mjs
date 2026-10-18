// Builds the Chrome Web Store version and zips it for upload: release/streamgrab-store-<version>.zip, with
// manifest.json at the root of the archive. Run via `npm run package:store`; needs the `zip` command.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['scripts/build.mjs', '--store'], { cwd: root, stdio: 'inherit' });

const { version } = JSON.parse(readFileSync(resolve(root, 'dist-store/manifest.json'), 'utf8'));
const zip = resolve(root, `release/streamgrab-store-${version}.zip`);
mkdirSync(resolve(root, 'release'), { recursive: true });
rmSync(zip, { force: true });
// -X leaves out file attributes that differ between machines.
execFileSync('zip', ['-r', '-X', '-q', zip, '.', '-x', '*.DS_Store'], { cwd: resolve(root, 'dist-store'), stdio: 'inherit' });
console.log(`${zip.slice(root.length + 1)}  ${(statSync(zip).size / 1e6).toFixed(2)} MB`);
