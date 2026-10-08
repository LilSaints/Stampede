import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { capture, findExecutable } from '../dist/src/hub/capabilities.js';
import { workerEnv } from '../dist/src/backends/procs.js';

// No credentials are copied and no model prompts are submitted. Installation
// is confined to a disposable CLAUDE_CONFIG_DIR, with an isolated working dir.
const output = path.resolve(process.argv[2] ?? `spikes/artifacts/s17-package-${Date.now()}`);
// Optional bundle directory lets qualification use fresh release candidates
// while another long-running probe retains its original dist files.
const runtimeDirectory = path.resolve(process.argv[3] ?? 'dist');
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(os.tmpdir(), 'stampede-package-'));
const plugin = path.join(fixture, 'plugin'), config = path.join(fixture, 'claude'), home = path.join(fixture, 'state'), cwd = path.join(fixture, 'workspace');
for (const directory of [plugin, config, home, cwd]) await mkdir(directory);
const result = { at: new Date().toISOString(), fixture, runtimeDirectory };
let descriptor, token;
try {
  for (const file of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json', 'hooks/stampede-ui.tsx', 'types/index.d.ts', 'skills/stampede-workflows/SKILL.md', 'dist/cli.js', 'dist/worker.js', 'dist/hook.js', 'dist/windows-helper.ps1']) {
    const target = path.join(plugin, file); await mkdir(path.dirname(target), { recursive: true }); await copyFile(file.startsWith('dist/') ? path.join(runtimeDirectory, file.slice(5)) : file, target);
  }
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'stampede', version, type: 'module' }));
  await writeFile(path.join(fixture, 'disabled.json'), JSON.stringify({ enabledPlugins: { 'stampede@stampede': false } }));
  const env = workerEnv({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(config, 'plugins'), STAMPEDE_HOME: home });
  const binary = await findExecutable('claude');
  const invoke = (...args) => capture(binary, args, cwd, env);
  result.install = await invoke('plugin', 'install', 'stampede', '--marketplace', plugin, '--scope', 'user', '--json');
  if (result.install.code !== 0) throw new Error('isolated plugin install failed');
  result.enabled = await invoke('mcp', 'list');
  // Opening the plugin source as a workspace must not discover a second,
  // plain project server with unresolved plugin-only variables.
  result.fromPluginRoot = await capture(binary, ['mcp', 'list'], plugin, env);
  if (result.fromPluginRoot.code !== 0 || !result.fromPluginRoot.stdout.includes('plugin:stampede:stampede') || /(?:^|\n)stampede:|Failed to connect|Missing environment variables/.test(result.fromPluginRoot.stdout + result.fromPluginRoot.stderr)) throw new Error('plugin workspace MCP discovery failed');
  result.disabled = await invoke('--settings', path.join(fixture, 'disabled.json'), 'mcp', 'list');
  result.excluded = result.enabled.stdout.includes('stampede') && !result.disabled.stdout.includes('plugin:stampede:stampede');
  descriptor = JSON.parse(await readFile(path.join(home, 'hub.json'), 'utf8'));
  token = (await readFile(path.join(home, 'hub.token'), 'utf8')).trim();
  const call = async (tool, input) => {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/orch/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
  };
  const run = await call('workflow_run', { cwd, script: 'export const meta={name:"packaged",description:"isolated install"}; return 42;' });
  await call('workflow_wait', { runId: run.runId, timeoutSec: 5 });
  const final = await call('workflow_result', { runId: run.runId });
  result.packagedWorkflow = final.status === 'completed' && final.result === 42;
  result.passed = result.install.code === 0 && result.enabled.code === 0 && result.disabled.code === 0 && result.excluded && result.packagedWorkflow;
} catch (error) { result.error = error.stack; result.passed = false; }
finally {
  try {
    descriptor ??= JSON.parse(await readFile(path.join(home, 'hub.json'), 'utf8'));
    token ??= (await readFile(path.join(home, 'hub.token'), 'utf8')).trim();
    await fetch(`http://127.0.0.1:${descriptor.port}/v1/hub/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"force":true}' });
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
  if (path.dirname(fixture) === path.resolve(os.tmpdir()) && path.basename(fixture).startsWith('stampede-package-')) { await rm(fixture, { recursive: true, force: true }); result.fixtureRemoved = true; }
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;
