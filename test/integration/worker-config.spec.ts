import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';
import type { BackendInfo } from '../../src/hub/capabilities.js';

const meta = 'export const meta = { name: "worker-config", description: "per-agent tools, MCP servers and plugins" };\n';

test('a call chooses its worker\'s built-in tools, MCP servers and plugins', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-worker-config-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  for (const args of [['init', '-q'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'base']]) execFileSync('git', args, { cwd, windowsHide: true });
  // The user's own configuration: an MCP server for this project (local scope) and one for every project, plugins, Codex's servers.
  const claudeHome = path.join(root, 'claude'), codexHome = path.join(root, 'codex');
  await mkdir(path.join(claudeHome, 'plugins'), { recursive: true }); await mkdir(codexHome);
  await writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ mcpServers: { userwide: { command: 'user-server' } }, projects: { [cwd.replaceAll('\\', '/')]: { mcpServers: { unreal: { command: 'unreal-bridge', args: ['--port', '${UNREAL_PORT:-8080}'] } } } } }));
  await writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'stampede@stampede': true, 'unreal-tools@market': false } }));
  await writeFile(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'unreal-tools@market': [], 'docs@market': [] } }));
  await writeFile(path.join(codexHome, 'config.toml'), '[mcp_servers.unreal]\ncommand = "unreal-bridge"\nargs = ["--codex"]\n');
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claudeHome; process.env.CODEX_HOME = codexHome;
  const config = defaults();
  const fake: BackendInfo = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { claude: fake, codex: fake } });
  const run = async (opts: string, prompt = 'fixture:launch') => {
    const { runId } = await hub.manager.start({ cwd, script: meta + `return await agent(${JSON.stringify(prompt)}, ${opts});` });
    await hub.manager.active.get(runId)?.task;
    return hub.manager.get(runId);
  };
  try {
    // A lean Claude worker: its tools, servers by name and inline, every plugin off but one.
    const lean = await run('{ name: "lean", backend: "claude", tools: ["Grep", "Bogus"], mcpServers: ["unreal", "userwide", { broken: { command: "missing-binary" } }], plugins: { "*": false, "unreal-tools": true } }');
    const { argv, mcp, settings } = JSON.parse(lean.result as string);
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Grep,Bogus');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'default', 'a read-only worker with servers is not in plan mode');
    const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
    for (const name of ['unreal', 'userwide', 'broken']) assert.ok(allowed.includes(`mcp__${name}__*`), `${name}'s tools are allowed`);
    assert.deepEqual(mcp.mcpServers, { unreal: { command: 'unreal-bridge', args: ['--port', '${UNREAL_PORT:-8080}'] }, userwide: { command: 'user-server' }, broken: { command: 'missing-binary' } });
    assert.deepEqual(settings.enabledPlugins, { 'unreal-tools@market': true, 'docs@market': false, 'stampede@stampede': false });
    assert.ok(lean.log.includes('lean: Claude Code has no tool named Bogus, so the worker runs without it'), lean.log.join('\n'));
    assert.ok(lean.log.includes('lean: MCP server broken is failed, so the worker runs without its tools'));
    // Servers given as one { name: config } map, as .mcp.json holds them, launch as the list form does.
    const mapped = JSON.parse((await run('{ name: "mapped", backend: "claude", mcpServers: { a: { command: "node", args: ["s.js"] } } }')).result as string);
    assert.deepEqual(mapped.mcp.mcpServers, { a: { command: 'node', args: ['s.js'] } });
    assert.ok(mapped.argv.slice(mapped.argv.indexOf('--allowedTools') + 1).includes('mcp__a__*'));
    // A worker without the options keeps today's launch: no tool list, no servers, only Stampede's plugin off.
    const plain = JSON.parse((await run('{ name: "plain", backend: "claude" }')).result as string);
    assert.ok(!plain.argv.includes('--tools')); assert.deepEqual(plain.mcp.mcpServers, {}); assert.deepEqual(plain.settings.enabledPlugins, { 'stampede@stampede': false });
    assert.equal(plain.argv[plain.argv.indexOf('--permission-mode') + 1], 'plan');
    // An agent type that lists its tools gets the call's servers added to its copy.
    await mkdir(path.join(cwd, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(cwd, '.claude', 'agents', 'scout.md'), '---\nname: scout\ndescription: Scouts\ntools: Read, Grep\n---\nScout.\n');
    const typed = JSON.parse((await run('{ name: "typed", backend: "claude", agentType: "scout", mcpServers: ["userwide"] }', 'fixture:argv')).result as string).argv as string[];
    const agents = JSON.parse(await readFile(typed[typed.indexOf('--agents') + 1]!, 'utf8'));
    assert.deepEqual(agents['stampede-scout'].tools, ['Read', 'Grep', 'mcp__userwide']);
    // Codex takes a name from its own config.toml and an inline server in Claude's shape, its variables expanded.
    const codex = JSON.parse((await run('{ name: "cx", backend: "codex", env: { WEB_TOKEN: "fixture-token" }, mcpServers: ["unreal", { web: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${WEB_TOKEN}" } } }] }', 'fixture:argv')).result as string).argv as string[];
    for (const arg of ['mcp_servers.unreal.command="unreal-bridge"', 'mcp_servers.unreal.args=["--codex"]', 'mcp_servers.unreal.default_tools_approval_mode="approve"', 'mcp_servers.web.url="https://example.invalid/mcp"', 'mcp_servers.web.http_headers={Authorization="Bearer fixture-token"}', 'mcp_servers.web.default_tools_approval_mode="approve"']) assert.ok(codex.includes(arg), arg);
    // A server the user's configuration lacks fails that agent alone, and says why.
    const missing = await run('{ name: "lost", backend: "claude", mcpServers: ["nowhere"] }');
    assert.equal(missing.result, null);
    assert.ok(missing.log.some(line => line.startsWith('lost: mcpServers: no MCP server named nowhere in your Claude Code config')), missing.log.join('\n'));
    // What the hub would never give, or a backend cannot take, fails the call.
    for (const [opts, error] of [
      ['{ backend: "claude", tools: ["Read", "Edit"] }', /tools cannot include Edit: read-only access has no edit tools/],
      ['{ backend: "claude", access: "edit", tools: ["Bash"] }', /tools cannot include Bash: edit access has no shell while claude.editShellAllow is empty/],
      ['{ backend: "claude", access: "read-only", isolation: "worktree", shell: true }', /shell runs the claude.editShellAllow commands, and that list is empty/],
      ['{ backend: "claude", tools: ["Workflow"] }', /tools cannot include Workflow: workers never start agents, teams or workflows/],
      ['{ backend: "claude", tools: ["CronCreate"] }', /tools cannot include CronCreate: claude.denyTools removes it/],
      ['{ backend: "codex", tools: ["Read"] }', /tools is for Claude workers/],
      ['{ backend: "codex", plugins: { "*": false } }', /plugins is for Claude workers/],
      ['{ backend: "claude", plugins: { stampede: true } }', /workers never load Stampede's own plugin/],
      ['{ backend: "claude", mcpServers: ["stampede"] }', /stampede is Stampede's own server/],
      ['{ backend: "claude", mcpServers: [{ a: { url: "ftp://x" } }] }', /mcpServers.a: an http server needs an http\(s\) url/],
    ] as const) assert.match(String((await run(opts)).error?.message), error, opts);
  } finally {
    await hub.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
