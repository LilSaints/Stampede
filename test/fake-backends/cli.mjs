import { readFile, writeFile } from 'node:fs/promises';
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
if (prompt === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
if (prompt === 'fixture:edit') await writeFile('fixture-output.txt', 'verified fixture edit\n');
let scenarioOutput;
if (prompt.startsWith('fixture:team') || prompt === 'fixture:burst' || prompt === 'fixture:wait' || prompt === 'fixture:read-board') {
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
    else if (prompt === 'fixture:burst') {
      const identity = await tool('whoami', {});
      for (let i = 0; i < 50; i++) await tool('send_message', { to: '*', text: `${identity.name}:${i}` });
      const received = [];
      while (received.length < 150) {
        const batch = await tool('read_messages', { max: 50 });
        received.push(...batch.messages);
        if (!batch.messages.length) await new Promise(resolve => setTimeout(resolve, 5));
      }
      scenarioOutput = JSON.stringify({ received: received.length, ordered: received.every((message, i) => i === 0 || message.seq > received[i - 1].seq), unique: new Set(received.map(m => m.seq)).size });
      await tool('mark_done', {});
    } else {
      await tool('post_finding', { title: prompt, body: 'fixture finding', topic: 'test' });
      await tool('send_message', { to: 'orchestrator', text: 'fixture complete' });
      await tool('mark_done', {});
      if (prompt === 'fixture:team-delayed') await new Promise(resolve => setTimeout(resolve, 600));
    }
  } finally { await client.close(); }
}
const output = process.env.STAMPEDE_FIXTURE_RESULT ?? scenarioOutput ?? prompt;
if (codex) {
  emit({ type: 'thread.started', thread_id: id });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: output } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } });
  const last = argv.indexOf('-o'); if (last >= 0) await writeFile(argv[last + 1], output);
} else emit({ type: 'result', subtype: 'success', session_id: id, result: output, ...(argv.includes('--json-schema') ? { structured_output: JSON.parse(output) } : {}), usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.001 });
