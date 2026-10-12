// Real-CLI probe for `protect` and `shell` (Claude Code, Haiku, a few cents of usage):
// 1. Which Edit/Write deny-rule path forms Claude enforces: relative `./`, `//`-absolute, and the hub's plain absolute form.
// 2. A read-only worker in permission mode `default` with one allowlisted command: it runs that one and is refused another.
// Usage: node spikes/claude-protect-shell.mjs <output dir> [claude binary]
import { mkdtemp, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const out = path.resolve(process.argv[2] ?? 'spikes/artifacts/claude-protect-shell');
const claude = process.argv[3] ?? (process.platform === 'win32' ? execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0] : 'claude');
const git = (cwd, args) => execFileSync('git', ['-c', 'user.email=probe@example.invalid', '-c', 'user.name=probe', ...args], { cwd, windowsHide: true });
async function repo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'protect-shell-probe-'));
  await mkdir(path.join(dir, 'docs'));
  for (const file of ['HANDOFF.md', 'docs/a.md', 'other.txt']) await writeFile(path.join(dir, file), 'orig\n');
  git(dir, ['init', '-q']); git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'base']);
  return dir;
}
async function run(dir, deny, args, prompt) {
  const settings = `${dir}-settings.json`;
  await writeFile(settings, JSON.stringify({ permissions: { deny } }));
  const r = spawnSync(claude, ['-p', '--output-format', 'json', '--model', 'haiku', '--settings', settings, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...args], { cwd: dir, input: prompt, encoding: 'utf8', timeout: 240000 });
  const json = JSON.parse(r.stdout);
  return { denials: json.permission_denials.map(d => `${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 160)}`), result: String(json.result).slice(0, 400) };
}
const summary = { claude: execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim(), denyForms: {}, readOnlyShell: undefined };
for (const [label, form] of [['relative ./', (dir, p) => `./${p}`], ['absolute //', (dir, p) => `//${dir.replaceAll('\\', '/')}/${p}`], ['absolute (hub store form)', (dir, p) => `${dir.replaceAll('\\', '/')}/${p}`]]) {
  const dir = await repo();
  const deny = ['HANDOFF.md', 'docs/**'].flatMap(p => ['Edit', 'Write'].map(tool => `${tool}(${form(dir, p)})`));
  const outcome = await run(dir, deny, ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Edit', 'Write', '--disallowedTools', 'Bash', 'PowerShell'], 'Use the Edit tool (not Bash) to replace "orig" with "changed" in each of these files: HANDOFF.md, docs/a.md, other.txt. Try every file even if one fails. Then list which succeeded.');
  const files = {}; for (const file of ['HANDOFF.md', 'docs/a.md', 'other.txt']) files[file] = (await readFile(path.join(dir, file), 'utf8')).trim();
  summary.denyForms[label] = { deny, files, enforced: files['HANDOFF.md'] === 'orig' && files['docs/a.md'] === 'orig' && files['other.txt'] === 'changed', ...outcome };
}
{
  const dir = await repo();
  const outcome = await run(dir, [], ['--permission-mode', 'default', '--allowedTools', 'Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(mkdir allowed-dir)', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit'], 'Run these shell commands with the Bash tool, one call each, and report the result of each (output, or refused): 1) `git status --short` 2) `mkdir allowed-dir` 3) `mkdir other-dir`');
  const entries = await readdir(dir);
  summary.readOnlyShell = { entries, allowedRan: entries.includes('allowed-dir'), otherRefused: !entries.includes('other-dir'), ...outcome };
}
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
