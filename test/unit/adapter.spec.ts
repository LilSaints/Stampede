import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, copyFile, writeFile } from 'node:fs/promises';
import { codexArgv } from '../../src/backends/codex.js';
import { claudeArgv, claudeRulePath } from '../../src/backends/claude.js';
import { launchTurn, workerEnv } from '../../src/backends/procs.js';
import type { AgentLaunch } from '../../src/backends/adapter.js';
import { defaults } from '../../src/hub/config.js';
function launch(dir: string): AgentLaunch { return { backend: 'codex', binary: process.execPath, entry: path.resolve('test/fake-backends/cli.mjs'), cwd: dir, access: 'read-only', model: 'fixture', effort: 'low', mcpPath: '', settingsPath: '', contract: 'fixture', comms: false, hubUrl: '', cliEntry: '', windowsSandbox: 'elevated', timeoutMs: 3000, stdoutPath: path.join(dir, 'stdout.jsonl'), stderrPath: path.join(dir, 'stderr.txt') }; }
test('a worker without comms gets only the Stampede tools the hub gives it, and an agent type copy by file', () => {
  const claude = claudeArgv({ ...launch('.'), backend: 'claude', access: 'edit', mcpTools: ['cleanup'], agentsPath: 'agents.json', agentType: 'stampede-reviewer' });
  assert.ok(claude.includes('mcp__stampede__cleanup')); assert.ok(!claude.includes('mcp__stampede__*'));
  assert.equal(claude[claude.indexOf('--agents') + 1], 'agents.json'); assert.equal(claude[claude.indexOf('--agent') + 1], 'stampede-reviewer');
  const codex = codexArgv({ ...launch('.'), access: 'edit', mcpTools: ['cleanup'], token: 'fixture-token' }, { platform: 'linux' });
  assert.ok(codex.some(arg => arg.startsWith('mcp_servers.stampede.env=') && arg.includes('"STAMPEDE_AGENT_TOOLS"="cleanup"')));
  assert.ok(!codexArgv(launch('.'), { platform: 'linux' }).some(arg => arg.startsWith('mcp_servers.stampede')));
});
test('a call\'s tool list and MCP servers reach the argv: Claude allows the servers\' tools, Codex gets them field by field', () => {
  const servers = { unreal: { command: 'unreal-bridge', args: ['--port', '8080'], env: { 'odd key': 'v' } }, web: { url: 'https://example.invalid/mcp', http_headers: { Authorization: 'Bearer t' } } };
  const claude = claudeArgv({ ...launch('.'), backend: 'claude', tools: ['Grep', 'Read'], mcpServers: servers });
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Grep,Read');
  assert.ok(claude.indexOf('--tools') < claude.indexOf('--allowedTools'));
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'default');
  for (const tool of ['mcp__unreal__*', 'mcp__web__*']) assert.ok(claude.slice(claude.indexOf('--allowedTools'), claude.indexOf('--disallowedTools')).includes(tool));
  const none = claudeArgv({ ...launch('.'), backend: 'claude', tools: [] });
  assert.equal(none[none.indexOf('--tools') + 1], '');
  assert.equal(none[none.indexOf('--permission-mode') + 1], 'plan');
  const a = { ...launch('.'), mcpServers: servers };
  const codex = codexArgv(a, { platform: 'linux' });
  for (const arg of ['mcp_servers.unreal.command="unreal-bridge"', 'mcp_servers.unreal.args=["--port","8080"]', 'mcp_servers.unreal.env={"odd key"="v"}', 'mcp_servers.web.url="https://example.invalid/mcp"', 'mcp_servers.web.http_headers={Authorization="Bearer t"}', 'mcp_servers.unreal.default_tools_approval_mode="approve"', 'mcp_servers.web.default_tools_approval_mode="approve"']) assert.ok(codex.includes(arg), arg);
  assert.deepEqual(codexArgv(a, { platform: 'linux', resumeThreadId: 'thread' }), [...codex.slice(0, -1), 'resume', 'thread', '-']);
});
test('an edit worker may also write its scratch folders outside its workspace', () => {
  const dirs = ['C:\\scratch\\a', 'D:\\b'];
  const claude = claudeArgv({ ...launch('.'), backend: 'claude', access: 'edit', writableDirs: dirs });
  assert.deepEqual(claude.slice(claude.indexOf('--add-dir'), claude.indexOf('--add-dir') + 4), ['--add-dir', ...dirs, '--allowedTools']);
  assert.ok(!claudeArgv({ ...launch('.'), backend: 'claude', access: 'edit' }).includes('--add-dir'));
  const codex = codexArgv({ ...launch('.'), access: 'edit', writableDirs: dirs }, { platform: 'win32' });
  assert.ok(codex.includes('sandbox_workspace_write.writable_roots=["C:\\\\scratch\\\\a","D:\\\\b"]'));
  assert.ok(!codexArgv({ ...launch('.'), access: 'full', writableDirs: dirs }).some(arg => arg.startsWith('sandbox_workspace_write')));
});
test('Claude permission rules name folders by the absolute form each platform enforces', () => {
  // A single leading slash is relative to the settings' root, and Windows paths match as /c/…, so both platforms take //.
  assert.equal(claudeRulePath('/home/fixture/.stampede', 'linux'), '//home/fixture/.stampede');
  assert.equal(claudeRulePath('/Users/fixture/repo/.stampede/worktrees/run/agent/', 'darwin'), '//Users/fixture/repo/.stampede/worktrees/run/agent');
  assert.equal(claudeRulePath('C:\\Users\\Fixture\\.stampede', 'win32'), '//c/Users/Fixture/.stampede');
  assert.equal(claudeRulePath('D:\\work\\repo\\', 'win32'), '//d/work/repo');
});
test('Codex resume preserves all options before the resume tail', () => {
  const a = { ...launch('.'), comms: true, token: 'test-token' };
  const start = codexArgv(a, { platform: 'win32' });
  const resume = codexArgv(a, { platform: 'win32', resumeThreadId: 'thread' });
  assert.deepEqual(resume, [...start.slice(0, -1), 'resume', 'thread', '-']);
  assert.ok(start.indexOf('windows.sandbox="elevated"') > start.indexOf('--ignore-user-config'));
  assert.ok(start.includes('mcp_servers.stampede.default_tools_approval_mode="approve"'));
  assert.ok(start.includes('approval_policy="never"'));
  assert.ok(!codexArgv({ ...a, developerInstructionsFlag: false }).some(arg => arg.startsWith('developer_instructions=')));
  // Workers ignore the user's Codex config, so its approvals reviewer is passed only when configured.
  assert.ok(!start.some(arg => arg.startsWith('approvals_reviewer=')));
  assert.ok(codexArgv({ ...a, approvalsReviewer: 'user' }).includes('approvals_reviewer="user"'));
});
test('Claude read-only coordination permits messaging without file edits or shell tools', () => {
  const argv = claudeArgv({ ...launch('.'), backend: 'claude', comms: true });
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'default');
  assert.ok(argv.includes('mcp__stampede__*'));
  const denied = argv.slice(argv.indexOf('--disallowedTools') + 1);
  for (const tool of ['Edit', 'Write', 'Bash', 'PowerShell', 'Agent', 'Task']) assert.ok(denied.includes(tool));
  assert.ok(!claudeArgv({ ...launch('.'), comms: true, persistNonComms: false }).includes('--no-session-persistence'));
  assert.ok(claudeArgv({ ...launch('.'), comms: false, persistNonComms: false }).includes('--no-session-persistence'));
});
test('Claude workers never get Workflow; configured tools and skills are removed at every access level', () => {
  const denyTools = defaults().claude.denyTools;
  for (const access of ['read-only', 'edit', 'full'] as const) {
    const argv = claudeArgv({ ...launch('.'), backend: 'claude', access, denyTools });
    const denied = argv.slice(argv.indexOf('--disallowedTools') + 1);
    for (const tool of ['Agent', 'Task', 'TeamCreate', 'TeamDelete', 'Workflow', 'CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'DesignSync', 'EnterWorktree']) assert.ok(denied.includes(tool), `${access} denies ${tool}`);
    const kept = ['Read', 'Glob', 'Grep', 'ToolSearch', 'SendMessage', 'ListAgents', 'StructuredOutput', ...(access === 'read-only' ? [] : ['Edit', 'Write']), ...(access === 'full' ? ['Bash', 'PowerShell'] : [])];
    for (const tool of kept) assert.ok(!denied.includes(tool), `${access} keeps ${tool}`);
    assert.ok(!argv.includes('--disable-slash-commands'));
  }
  const bare = claudeArgv({ ...launch('.'), backend: 'claude', access: 'full' });
  assert.deepEqual(bare.slice(bare.indexOf('--disallowedTools') + 1), ['Agent', 'Task', 'TeamCreate', 'TeamDelete', 'Workflow']);
  assert.ok(claudeArgv({ ...launch('.'), backend: 'claude', skills: false }).includes('--disable-slash-commands'));
});
test('a Codex turn that reconnects and completes succeeds; one whose stream is lost fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-reconnect-'));
  try {
    const recovered = await launchTurn(launch(dir), 'fixture:reconnect').done;
    assert.equal(recovered.ok, true); assert.equal(recovered.error, undefined); assert.equal(recovered.text, 'fixture:reconnect');
    const lost = await launchTurn(launch(dir), 'fixture:stream-lost').done;
    assert.equal(lost.ok, false); assert.match(lost.error!.message, /stream disconnected/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('shell-free backend receives a long UTF-8 prompt over stdin and preserves resume session', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede adapter space '));
  try {
    const a = launch(dir); a.entry = path.join(dir, 'fake backend.mjs');
    await copyFile(path.resolve('test/fake-backends/cli.mjs'), a.entry);
    const prompt = 'é'.repeat(50000);
    const first = await launchTurn(a, prompt).done;
    assert.equal(first.ok, true); assert.equal(first.text, prompt);
    assert.equal(first.usage.reasoningTokens, 1);
    const next = await launchTurn(a, 'continued', { resumeSessionId: first.sessionId }).done;
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(next.text, 'continued');
    const fallback = await launchTurn({ ...a, developerInstructionsFlag: false }, 'prompt').done;
    assert.equal(fallback.text, '<stampede-contract>\nfixture\n</stampede-contract>\nprompt');
    const claude = await launchTurn({ ...a, backend: 'claude' }, prompt).done;
    assert.equal(claude.ok, true); assert.equal(claude.text, prompt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows cancellation kills the worker and its descendant', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede kill tree '));
  let handle: ReturnType<typeof launchTurn> | undefined;
  try {
    const entry = path.join(dir, 'tree fixture.mjs');
    await writeFile(entry, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
child.once('spawn',()=>console.log(JSON.stringify({type:'fixture.child',pid:child.pid})));
process.stdin.resume(); setInterval(()=>{},1000);`);
    let descendant: number | undefined;
    handle = launchTurn({ ...launch(dir), entry, timeoutMs: 12000 }, 'fixture', { onEvent(event) { if (event.type === 'fixture.child') descendant = event.pid; } });
    const deadline = Date.now() + 10000;
    while (!descendant && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(descendant, 'descendant startup must be observed before cancellation');
    process.kill(descendant, 0);
    await handle.kill();
    assert.equal((await handle.done).error?.kind, 'cancelled');
    assert.throws(() => process.kill(descendant!, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(handle!.pid!, 0), { code: 'ESRCH' });
  } finally { await handle?.kill(); await rm(dir, { recursive: true, force: true }); }
});
test('worker environment strips desktop identity and hub home; token logs are redacted', async () => {
  const before = process.env.STAMPEDE_HOME; process.env.STAMPEDE_HOME = 'private';
  try { assert.equal(workerEnv().STAMPEDE_HOME, undefined); } finally { if (before === undefined) delete process.env.STAMPEDE_HOME; else process.env.STAMPEDE_HOME = before; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-redact-'));
  try { const a = { ...launch(dir), token: 'fixture-secret' }; await launchTurn(a, 'fixture-secret').done; assert.ok(!(await readFile(a.stdoutPath, 'utf8')).includes('fixture-secret')); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
