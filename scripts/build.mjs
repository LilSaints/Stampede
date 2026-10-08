import { execFileSync } from 'node:child_process';
import { copyFile, readFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Keep individual modules for unit tests; ship only the four runtime files.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
const { VERSION, UI_API_VERSION } = await import('../dist/src/hub/config.js');
const metadata = await Promise.all(['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'].map(async file => JSON.parse(await readFile(file, 'utf8'))));
if ([metadata[0].version, metadata[1].version, metadata[2].plugins[0].version].some(version => version !== VERSION) || Number(VERSION.split('.')[0]) !== UI_API_VERSION) throw new Error('plugin, hub and UI API versions must agree');
await copyFile('src/hub/windows-helper.ps1', 'dist/src/hub/windows-helper.ps1');
await build({
  entryPoints: { cli: 'cli.ts', worker: 'src/runtime/worker.ts', hook: 'src/hook/entry.ts' },
  outdir: 'dist', entryNames: '[name]', bundle: true, platform: 'node',
  target: 'node22', format: 'esm', legalComments: 'eof',
  banner: { js: "import { createRequire as __stampedeCreateRequire } from 'node:module'; const require = __stampedeCreateRequire(import.meta.url);" }
});
await copyFile('src/hub/windows-helper.ps1', 'dist/windows-helper.ps1');
