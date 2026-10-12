import path from 'node:path';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
const codex = argv.includes('exec');
const resume = argv.indexOf(codex ? 'resume' : '--resume');
const id = resume >= 0 ? argv[resume + 1] : randomUUID();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (argv.includes('--version')) { console.log(path.basename(process.argv[1]).includes('claude') ?'Claude Code 2.1.292' : 'codex-cli 0.159.2'); process.exit(0); }
if (prompt === 'crash') { process.stderr.write('fixture crash'); process.exit(1); }
if (prompt === 'auth') { emit({ type: 'turn.failed', error: { message: '401 authentication failed' } }); process.exit(1); }
if (prompt === 'rate-limit') { emit({ type: 'turn.failed', error: { message: '429 rate limit fixture' } }); process.exit(1); }
if (prompt === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
if (prompt === 'fixture:edit') await writeFile('fixture-output.txt', 'verified fixture edit\n');
// A file of its own, so each agent of a chain adds a change; and a worktree locked, which git then refuses to remove.
if (prompt.startsWith('fixture:write:')) await writeFile(prompt.slice('fixture:write:'.length), 'written by fixture\n');
if (prompt === 'fixture:lock-worktree') execFileSync('git', ['worktree', 'lock', '--reason', 'fixture', process.cwd()], { windowsHide: true });
if (/^fixture:recovery:[ab]$/.test(prompt)) {
  await mkdir('.stampede', { recursive: true });
  const marker = `.stampede/recovery-${prompt.at(-1)}.json`;
  let prior; try { prior = await readFile(marker, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!prior) {
    await writeFile(marker, JSON.stringify({ pid: process.pid }));
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
}
let scenarioOutput;
// A first turn that records a session to resume and leaves work in its workspace, then stops answering
// while the hub is killed under it. Continued, it reports the session it resumed and the work it found;
// started again where the work already is, it says so.
// The work marker is in the worktree for Codex (an edit agent) and beside the session for Claude, a
// read-only agent that must not change the project its call is keyed on.
const marker = () => codex ? 'partial.txt' : path.join(process.env.CLAUDE_CONFIG_DIR ?? '.', 'partial.txt');
if (prompt.startsWith('fixture:continue')) {
  let partial; try { partial = await readFile(marker(), 'utf8'); } catch {}
  if (partial) scenarioOutput = `restarted with ${partial}`;
  else {
    if (codex) {
      const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '09');
      await mkdir(day, { recursive: true }); await writeFile(path.join(day, `rollout-fixture-${id}.jsonl`), '{}\n');
      emit({ type: 'thread.started', thread_id: id });
    } else {
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, `${id}.jsonl`), '{}\n');
      emit({ type: 'system', subtype: 'init', session_id: id });
    }
    await writeFile(marker(), prompt);
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
}
if (prompt.startsWith('Your previous turn on this task was interrupted')) {
  let partial = 'nothing'; try { partial = await readFile(marker(), 'utf8'); } catch {}
  scenarioOutput = `continued ${resume >= 0 ? id : 'without a session'} with ${partial}`;
}
// Steering: a Codex turn running tool calls until the hub cuts it after one, then the resumed turn (or the one
// after an answer, for a message that came too late) reports the message its prompt carried.
const message = [...prompt.matchAll(/<stampede-message[^>]*>\n([\s\S]*?)\n<\/stampede-message>/g)].map(match => match[1]).join(' | ');
if (prompt.startsWith('The orchestrator sent you the message below')) scenarioOutput = `steered: ${message}`;
if (prompt.startsWith('You were idle and received new messages')) scenarioOutput = `resumed: ${message}`;
if (prompt === 'fixture:steer' && codex) {
  emit({ type: 'thread.started', thread_id: id }); emit({ type: 'turn.started' });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 150; i++) {
    emit({ type: 'item.started', item: { id: `item_${i}`, type: 'command_execution', command: 'step' } }); await pause(40);
    emit({ type: 'item.completed', item: { id: `item_${i}`, type: 'command_execution', command: 'step', exit_code: 0 } }); await pause(40);
  }
  scenarioOutput = 'not steered';
}
if (prompt === 'fixture:slow') { await new Promise(resolve => setTimeout(resolve, 1500)); scenarioOutput = 'slow done'; }
// The worker's own argv, for a test to inspect how the hub launched it.
if (prompt === 'fixture:argv') scenarioOutput = JSON.stringify({ argv });
// How the hub launched a Claude worker (argv, MCP config, settings), after the init event Claude starts with:
// the tools `--tools` keeps of the three this fake has, and each server connected but one whose command is missing.
if (prompt === 'fixture:launch' && !codex) {
  const file = flag => readFile(argv[argv.indexOf(flag) + 1], 'utf8').then(JSON.parse);
  const mcp = await file('--mcp-config'), settings = await file('--settings');
  const builtIn = ['Read', 'Grep', 'Glob'], tools = argv.includes('--tools') ? argv[argv.indexOf('--tools') + 1].split(',').filter(tool => builtIn.includes(tool)) : builtIn;
  emit({ type: 'system', subtype: 'init', session_id: id, tools, mcp_servers: Object.entries(mcp.mcpServers).map(([name, server]) => ({ name, status: server.command === 'missing-binary' ? 'failed' : 'connected' })) });
  scenarioOutput = JSON.stringify({ argv, mcp, settings });
}
// One variable of the worker's environment, for a test of `env`.
if (prompt.startsWith('fixture:env:')) scenarioOutput = process.env[prompt.slice('fixture:env:'.length)] ?? 'unset';
// A worker that deletes its own scratch folder before it is done.
if (prompt.startsWith('fixture:rm-scratch:')) { await rm(prompt.slice('fixture:rm-scratch:'.length), { recursive: true, force: true }); scenarioOutput = 'removed'; }
if (prompt.startsWith('Adversarially verify: fixture-')) scenarioOutput = JSON.stringify({ isReal: prompt.endsWith('fixture-real') });
const referenceJudge = /^Judge "(fixture-real|fixture-rejected)" via the (correctness|security|repro) lens/.exec(prompt);
if (referenceJudge) scenarioOutput = JSON.stringify({ real: referenceJudge[1] === 'fixture-real' && referenceJudge[2] !== 'repro' });
const designJudge = /^Score fixture design ([ABC])$/.exec(prompt);
if (designJudge) scenarioOutput = JSON.stringify({ score: { A: 7, B: 10, C: 9 }[designJudge[1]] });
if (prompt.startsWith('fixture:team') || prompt.startsWith('fixture:burst') || prompt.startsWith('fixture:recovery:') || prompt === 'fixture:wait' || prompt === 'fixture:read-board' || prompt.startsWith('fixture:cleanup:') || prompt.startsWith('fixture:lock:')) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const server = codex
    ? { command: process.execPath, args: JSON.parse(argv.find(arg => arg.startsWith('mcp_servers.stampede.args=')).split('=').slice(1).join('=')) }
    : JSON.parse(await readFile(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.stampede;
  const client = new Client({ name: 'stampede-fake-worker', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), ...server.env }, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => process.stderr.write(chunk));
  await client.connect(transport);
  const tool = async (name, input) => {
    const response = await client.callTool({ name, arguments: input });
    const text = response.content.find(item => item.type === 'text')?.text ?? '{}';
    if (response.isError) throw new Error(text);
    return JSON.parse(text);
  };
  try {
    if (prompt === 'fixture:read-board') await tool('read_board', {});
    else if (prompt.startsWith('fixture:cleanup:')) {
      // Fixtures in its scratch folder, which it asks the hub to delete, and a path outside it the hub must refuse.
      const [scratch, outside] = prompt.slice('fixture:cleanup:'.length).split('|');
      await mkdir(path.join(scratch, 'junk'), { recursive: true }); await writeFile(path.join(scratch, 'junk', 'a.txt'), 'fixture');
      const { tools } = await client.listTools();
      scenarioOutput = JSON.stringify({ tools: tools.map(t => t.name), ...await tool('cleanup', { paths: [path.join(scratch, 'junk'), outside] }) });
    }
    else if (prompt.startsWith('fixture:lock:')) {
      // Takes a lock and leaves it for the hub to take back when the turn ends; a name its call did not give is refused.
      const name = prompt.slice('fixture:lock:'.length);
      const { tools } = await client.listTools();
      let refused = null; try { await tool('lock', { name: 'not-mine' }); } catch (error) { refused = error.message; }
      scenarioOutput = JSON.stringify({ tools: tools.map(t => t.name), lock: await tool('lock', { name, waitSec: 1 }), refused });
    }
    else if (prompt === 'fixture:wait') await tool('wait_for_message', { timeoutSec: 45 });
    else if (prompt.startsWith('fixture:burst')) {
      const identity = await tool('whoami', {});
      let randomState = ((Number(prompt.split(':')[2]) || 1) ^ identity.name.charCodeAt(identity.name.length - 1)) >>> 0;
      const jitter = async () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; await new Promise(resolve => setTimeout(resolve, randomState % 5)); };
      for (let i = 0; i < 50; i++) { await jitter(); await tool('send_message', { to: '*', text: `${identity.name}:${i}` }); }
      const received = [];
      while (received.length < 150) {
        const batch = await tool('read_messages', { max: 50 });
        received.push(...batch.messages);
        await jitter();
      }
      scenarioOutput = JSON.stringify({ received: received.length, ordered: received.every((message, i) => i === 0 || message.seq > received[i - 1].seq), unique: new Set(received.map(m => m.seq)).size });
      await tool('mark_done', {});
    } else {
      await tool('post_finding', { title: prompt, body: 'fixture finding', topic: 'test' });
      await tool('send_message', { to: 'orchestrator', text: 'fixture complete' });
      await tool('mark_done', {});
      if (prompt === 'fixture:team-delayed') await new Promise(resolve => setTimeout(resolve, 600));
      if (prompt === 'fixture:team-delayed-30s') await new Promise(resolve => setTimeout(resolve, 30000));
    }
  } finally { await client.close(); }
}
// A Claude worker's permission settings, as the hub wrote them, for a test to inspect.
if (prompt === 'fixture:settings' && !codex) scenarioOutput = await readFile(argv[argv.indexOf('--settings') + 1], 'utf8');
const output = process.env.STAMPEDE_FIXTURE_RESULT ?? scenarioOutput ?? prompt;
if (codex) {
  if (prompt === 'fixture:external') {
    emit({ type: 'item.completed', item: { type: 'web_search', query: 'synthetic dependency' } });
    for (const server of ['stampede', 'research']) emit({ type: 'item.completed', item: { type: 'mcp_tool_call', server, tool: 'lookup', arguments: { secret: 'fixture-not-for-journal' } } });
  }
  emit({ type: 'thread.started', thread_id: id });
  emit({ type: 'turn.started' });
  // Codex reports a stream it is retrying as an `error` event, and a lost one as `turn.failed`.
  if (prompt === 'fixture:reconnect') emit({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)' });
  if (prompt === 'fixture:stream-lost') { emit({ type: 'error', message: 'stream disconnected before completion' }); emit({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } }); process.exit(1); }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: output } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } });
  const last = argv.indexOf('-o'); if (last >= 0) await writeFile(argv[last + 1], output);
} else {
  if (prompt === 'fixture:external') emit({ type: 'assistant', message: { content: ['WebSearch', 'mcp__research__lookup', 'mcp__stampede__lookup'].map(name => ({ type: 'tool_use', name, input: { secret: 'fixture-not-for-journal' } })) } });
  // An agent type whose tools leave out the structured-output tool answers in a fenced block, or not in
  // JSON at all until the schema repair, resumed in its session, asks again.
  const unstructured = { 'fixture:fenced-json': 'Review done.\n```json\n{"verdict":"fix"}\n```\nThanks.', 'fixture:prose': 'The verdict is fix.' }[prompt];
  const repaired = resume >= 0 && prompt.startsWith('Your final message did not match the required JSON schema') ? '{"verdict":"fix"}' : undefined;
  if (unstructured !== undefined) emit({ type: 'result', subtype: 'success', session_id: id, result: unstructured, usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.001 });
  else emit({ type: 'result', subtype: 'success', session_id: id, result: repaired ?? output, ...(argv.includes('--json-schema') ? { structured_output: JSON.parse(repaired ?? output) } : {}), usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.001 });
}
