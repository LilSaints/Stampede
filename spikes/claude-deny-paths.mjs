// Real-CLI probe: which absolute path forms Claude Code enforces in Read/Edit deny rules on this platform, as the
// hub writes them for its state folder and other agents' worktrees (Claude Code, Haiku, a few cents of usage).
// Each case denies Read and Edit of one folder and asks the worker to read a file there and edit another; a case
// is enforced when Claude reports both refused. The anchoring cases check whether `Edit(./HANDOFF.md)` on a bare
// name, and the double-slash form for the whole path as `protect` writes it, match only at the cwd's root.
// Usage: node spikes/claude-deny-paths.mjs <output dir> [claude binary]
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const out = path.resolve(process.argv[2] ?? 'spikes/artifacts/claude-deny-paths');
const claude = process.argv[3] ?? (process.platform === 'win32' ? execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0] : 'claude');
const slashed = dir => dir.replaceAll('\\', '/');
// The path as Claude matches it: POSIX as it is; Windows `C:\x` as `/c/x` (its documented normalization).
const posix = dir => process.platform === 'win32' ? slashed(dir).replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : dir;
const forms = {
  'plain (the hub before #15)': dir => slashed(dir),
  'double slash': dir => `/${posix(dir)}`,
  // On POSIX the single-slash form is the plain one.
  ...(process.platform === 'win32' ? {
    'single slash': dir => posix(dir),
    'double slash, drive letter': dir => `//${slashed(dir)}`,
    'double slash, other case': dir => `/${posix(dir).toUpperCase()}`,
  } : {}),
};
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deny-paths-probe-'));
  await mkdir(path.join(dir, 'secret')); await mkdir(path.join(dir, 'sub'));
  await writeFile(path.join(dir, 'secret', 'token.txt'), 'NONCE-' + Math.random().toString(36).slice(2) + '\n');
  for (const file of ['secret/notes.txt', 'HANDOFF.md', 'sub/HANDOFF.md', 'other.txt']) await writeFile(path.join(dir, file), 'orig\n');
  return dir;
}
async function run(dir, deny, prompt) {
  const settings = `${dir}-settings.json`;
  await writeFile(settings, JSON.stringify({ permissions: { deny } }));
  const r = spawnSync(claude, ['-p', '--output-format', 'json', '--model', 'haiku', '--settings', settings, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Edit', '--disallowedTools', 'Bash', 'PowerShell', 'Write', 'Glob', 'Grep'], { cwd: dir, input: prompt, encoding: 'utf8', timeout: 240000 });
  const json = JSON.parse(r.stdout);
  return { denials: json.permission_denials.map(d => `${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 160)}`), result: String(json.result).slice(0, 600) };
}
const summary = { platform: process.platform, claude: execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim(), forms: {}, anchoring: {} };
for (const [label, form] of Object.entries(forms)) {
  const dir = await setup();
  const root = form(dir);
  const deny = [`Read(${root}/secret/**)`, `Edit(${root}/secret/**)`];
  const outcome = await run(dir, deny, 'Do these two steps with the Read and Edit tools, trying both even if one fails: 1) Read secret/token.txt and quote its content exactly. 2) Use Edit to replace "orig" with "changed" in secret/notes.txt. Report each result or refusal.');
  const nonce = (await readFile(path.join(dir, 'secret', 'token.txt'), 'utf8')).trim();
  const readRefused = outcome.denials.some(d => d.startsWith('Read ')), editRefused = outcome.denials.some(d => d.startsWith('Edit ')) && (await readFile(path.join(dir, 'secret', 'notes.txt'), 'utf8')).trim() === 'orig';
  summary.forms[label] = { deny, readRefused, editRefused, enforced: readRefused && editRefused, nonceInAnswer: outcome.result.includes(nonce), ...outcome };
}
for (const [label, rule] of [['relative bare name', () => 'Edit(./HANDOFF.md)'], ['double slash', dir => `Edit(/${posix(dir)}/HANDOFF.md)`]]) {
  const dir = await setup();
  const outcome = await run(dir, [rule(dir)], 'Use the Edit tool to replace "orig" with "changed" in each of HANDOFF.md, sub/HANDOFF.md and other.txt, trying each even if one fails. Report each result or refusal.');
  const files = {}; for (const file of ['HANDOFF.md', 'sub/HANDOFF.md', 'other.txt']) files[file] = (await readFile(path.join(dir, file), 'utf8')).trim();
  summary.anchoring[label] = { deny: [rule(dir)], files, rootOnly: files['HANDOFF.md'] === 'orig' && files['sub/HANDOFF.md'] === 'changed' && files['other.txt'] === 'changed', ...outcome };
}
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  platform: summary.platform, claude: summary.claude,
  forms: Object.fromEntries(Object.entries(summary.forms).map(([k, v]) => [k, { deny: v.deny[0], readRefused: v.readRefused, editRefused: v.editRefused }])),
  anchoring: Object.fromEntries(Object.entries(summary.anchoring).map(([k, v]) => [k, { deny: v.deny[0], files: v.files, rootOnly: v.rootOnly }])),
}, null, 2));
