import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
const codex = argv.includes('exec');
const resume = argv.indexOf(codex ? 'resume' : '--resume');
const id = resume >= 0 ? argv[resume + 1] : randomUUID();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (argv.includes('--version')) { console.log(process.argv[1].includes('claude') ? 'Claude Code 2.1.292' : 'codex-cli 0.159.2'); process.exit(0); }
if (prompt === 'crash') { process.stderr.write('fixture crash'); process.exit(1); }
if (prompt === 'auth') { emit({ type: 'turn.failed', error: { message: '401 authentication failed' } }); process.exit(1); }
if (prompt === 'rate-limit') { emit({ type: 'turn.failed', error: { message: '429 rate limit fixture' } }); process.exit(1); }
if (prompt === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
if (prompt === 'fixture:edit') await writeFile('fixture-output.txt', 'verified fixture edit\n');
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
if (prompt.startsWith('Adversarially verify: fixture-')) scenarioOutput = JSON.stringify({ isReal: prompt.endsWith('fixture-real') });
const referenceJudge = /^Judge "(fixture-real|fixture-rejected)" via the (correctness|security|repro) lens/.exec(prompt);
if (referenceJudge) scenarioOutput = JSON.stringify({ real: referenceJudge[1] === 'fixture-real' && referenceJudge[2] !== 'repro' });
const designJudge = /^Score fixture design ([ABC])$/.exec(prompt);
if (designJudge) scenarioOutput = JSON.stringify({ score: { A: 7, B: 10, C: 9 }[designJudge[1]] });
if (prompt.startsWith('fixture:team') || prompt.startsWith('fixture:burst') || prompt.startsWith('fixture:recovery:') || prompt === 'fixture:wait' || prompt === 'fixture:read-board') {
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
const output = process.env.STAMPEDE_FIXTURE_RESULT ?? scenarioOutput ?? prompt;
if (codex) {
  if (prompt === 'fixture:external') {
    emit({ type: 'item.completed', item: { type: 'web_search', query: 'synthetic dependency' } });
    for (const server of ['stampede', 'research']) emit({ type: 'item.completed', item: { type: 'mcp_tool_call', server, tool: 'lookup', arguments: { secret: 'fixture-not-for-journal' } } });
  }
  emit({ type: 'thread.started', thread_id: id });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: output } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } });
  const last = argv.indexOf('-o'); if (last >= 0) await writeFile(argv[last + 1], output);
} else {
  if (prompt === 'fixture:external') emit({ type: 'assistant', message: { content: ['WebSearch', 'mcp__research__lookup', 'mcp__stampede__lookup'].map(name => ({ type: 'tool_use', name, input: { secret: 'fixture-not-for-journal' } })) } });
  emit({ type: 'result', subtype: 'success', session_id: id, result: output, ...(argv.includes('--json-schema') ? { structured_output: JSON.parse(output) } : {}), usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.001 });
}
