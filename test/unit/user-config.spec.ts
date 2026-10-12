import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkPlugins, mcpServerEntries, mcpServerList, resolveMcpServers, resolvePlugins, toCodex } from '../../src/backends/userConfig.js';

test('mcpServers is a list of names and { name: config } servers in Claude\'s shape', () => {
  assert.deepEqual(mcpServerEntries(['unreal', { web: { type: 'http', url: 'https://example.invalid' } }]), [['unreal', undefined], ['web', { type: 'http', url: 'https://example.invalid' }]]);
  for (const [value, error] of [
    ['unreal', /a list of at most 20/],
    [Array(21).fill('a'), /a list of at most 20/],
    [['has space'], /not a server name/],
    [['Stampede'], /Stampede's own server/],
    [['a', 'A'], /a is named twice|A is named twice/],
    [[{ a: { command: 'x' }, b: { command: 'y' } }], /one server per entry/],
    [[{ a: { args: ['x'] } }], /a stdio server needs a command/],
    [[{ a: { type: 'sse' } }], /an sse server needs an http\(s\) url/],
    [[{ a: { type: 'ws', url: 'https://x' } }], /type must be stdio, http or sse/],
    [[{ a: { command: 'x', args: [1] } }], /args must be a list of strings/],
    [[{ a: { command: 'x', env: { K: 1 } } }], /env must map names to strings/],
  ] as const) assert.throws(() => mcpServerEntries(value), error, JSON.stringify(value));
});
test('mcpServers also takes one { name: config } map, the shape of .mcp.json and Claude settings', async () => {
  const map = { a: { command: 'node', args: ['s.js'] }, web: { type: 'http', url: 'https://example.invalid' } };
  assert.deepEqual(mcpServerList(map), [{ a: { command: 'node', args: ['s.js'] } }, { web: { type: 'http', url: 'https://example.invalid' } }]);
  assert.deepEqual(mcpServerList(['a']), ['a'], 'a list stays as it is');
  assert.deepEqual(mcpServerEntries(map), [['a', { command: 'node', args: ['s.js'] }], ['web', { type: 'http', url: 'https://example.invalid' }]]);
  assert.deepEqual(await resolveMcpServers(map, 'claude', os.tmpdir(), {}), map);
  assert.deepEqual(mcpServerEntries({}), []);
  for (const [value, error] of [
    [Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`s${i}`, { command: 'x' }])), /at most 20 servers/],
    [{ a: 'unreal' }, /mcpServers.a must be an MCP server config/],
    [{ stampede: { command: 'x' } }, /Stampede's own server/],
    [{ a: { args: ['x'] } }, /a stdio server needs a command/],
  ] as const) assert.throws(() => mcpServerEntries(value), error, JSON.stringify(value));
});
test('a named server is found as Claude Code finds it: local scope, then the project\'s .mcp.json, then user scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-mcp-names-'));
  const project = path.join(root, 'project'), deep = path.join(project, 'src', 'deep');
  await mkdir(deep, { recursive: true });
  const projectKey = process.platform === 'win32' ? project.replaceAll('\\', '/').toUpperCase() : project;
  await writeFile(path.join(root, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'user-a' }, b: { command: 'user-b' }, c: { command: 'user-c' } }, projects: { [projectKey]: { mcpServers: { a: { command: 'local-a' } } } } }));
  await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'project-a' }, b: { command: 'project-b' } } }));
  const env = { CLAUDE_CONFIG_DIR: root };
  assert.deepEqual(await resolveMcpServers(['a', 'b', 'c', { d: { command: 'inline-d' } }], 'claude', deep, env), { a: { command: 'local-a' }, b: { command: 'project-b' }, c: { command: 'user-c' }, d: { command: 'inline-d' } });
  await assert.rejects(resolveMcpServers(['e'], 'claude', deep, env), /no MCP server named e in your Claude Code config/);
  // Codex looks names up in its own config.toml, and takes inline servers converted to its shape.
  await writeFile(path.join(root, 'config.toml'), '[mcp_servers.a]\ncommand = "codex-a"\nenv = { K = "v" }\n');
  assert.deepEqual(await resolveMcpServers(['a', { d: { command: 'inline-d' } }], 'codex', deep, { CODEX_HOME: root }), { a: { command: 'codex-a', env: { K: 'v' } }, d: { command: 'inline-d' } });
  await assert.rejects(resolveMcpServers(['b'], 'codex', deep, { CODEX_HOME: root }), /no MCP server named b in your Codex config.toml/);
});
test('a server in Claude\'s shape becomes Codex\'s, its variables expanded', () => {
  const env = { HOST: 'example.invalid', TOKEN: 't' };
  assert.deepEqual(toCodex('s', { command: '${HOST}-bin', args: ['--port', '${PORT:-8080}'], env: { K: '${TOKEN}' } }, env), { command: 'example.invalid-bin', args: ['--port', '8080'], env: { K: 't' } });
  assert.deepEqual(toCodex('h', { type: 'http', url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }, env), { url: 'https://example.invalid/mcp', http_headers: { Authorization: 'Bearer t' } });
  assert.throws(() => toCodex('s', { command: '${MISSING}' }, env), /\$\{MISSING\} is not set/);
  assert.throws(() => toCodex('e', { type: 'sse', url: 'https://x' }, env), /Codex has no SSE transport/);
});
test('plugins: * sets every plugin the user has, a bare name each id of that name, and Stampede\'s stays off', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-plugins-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(root, 'plugins'), { recursive: true }); await mkdir(path.join(project, '.claude'), { recursive: true });
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ enabledPlugins: { 'stampede@stampede': true, 'docs@market': true } }));
  await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'unreal@studio': true } }));
  await writeFile(path.join(root, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'unreal@other': [], 'lint@market': [] } }));
  const env = { CLAUDE_CONFIG_DIR: root };
  assert.deepEqual(await resolvePlugins({ '*': false, unreal: true }, project, env), { 'stampede@stampede': false, 'docs@market': false, 'unreal@studio': true, 'unreal@other': true, 'lint@market': false });
  assert.deepEqual(await resolvePlugins({ 'cc-plugin-plugin-authoring@builtin': false }, project, env), { 'cc-plugin-plugin-authoring@builtin': false, 'stampede@stampede': false });
  await assert.rejects(resolvePlugins({ nothing: true }, project, env), /no installed plugin named nothing/);
  assert.throws(() => checkPlugins(['docs']), /plugins must map/);
  assert.throws(() => checkPlugins({ 'bad id!': false }), /plugins must map/);
  assert.throws(() => checkPlugins({ docs: 'yes' }), /plugins must map/);
  assert.throws(() => checkPlugins({ 'stampede@stampede': true }), /never load Stampede's own plugin/);
  checkPlugins({ '*': false, 'docs@market': true, stampede: false });
});
