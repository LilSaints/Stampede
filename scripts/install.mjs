import { copyFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Copy the built plugin into the release folder Claude Code installs from, so
// sessions run that copy and never the working tree. Run `npm run build` first.
const FILES = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json', 'hooks/stampede-ui.tsx', 'hooks/row.tsx', 'types/index.d.ts', 'skills/stampede-workflows/SKILL.md', 'dist/cli.js', 'dist/worker.js', 'dist/hook.js', 'dist/windows-helper.ps1', 'README.md'];
const target = path.resolve(process.argv[2] ?? process.env.STAMPEDE_RELEASE_DIR ?? path.join(os.homedir(), '.claude', 'stampede-release'));
for (const file of FILES) {
  await mkdir(path.dirname(path.join(target, file)), { recursive: true });
  await copyFile(file, path.join(target, file));
}
console.log(target);
