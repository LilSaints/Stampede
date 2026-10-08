import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
const codex = argv.includes('exec');
const resume = argv.indexOf(codex ? 'resume' : '--resume');
const id = resume >= 0 ? argv[resume + 1] : randomUUID();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (prompt === 'crash') { process.stderr.write('fixture crash'); process.exit(1); }
if (prompt === 'auth') { emit({ type: 'turn.failed', error: { message: '401 authentication failed' } }); process.exit(1); }
if (prompt === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
if (prompt.startsWith('fixture:team')) {
  const tool = async (name, input) => {
    const response = await fetch(process.env.STAMPEDE_HUB_URL + '/v1/agent/' + name, { method: 'POST', headers: { authorization: `Bearer ${process.env.STAMPEDE_AGENT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  await tool('post_finding', { title: prompt, body: 'fixture finding', topic: 'test' });
  await tool('send_message', { to: 'orchestrator', text: 'fixture complete' });
  await tool('mark_done', {});
  if (prompt === 'fixture:team-delayed') await new Promise(resolve => setTimeout(resolve, 600));
}
const output = process.env.STAMPEDE_FIXTURE_RESULT ?? prompt;
if (codex) {
  emit({ type: 'thread.started', thread_id: id });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: output } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } });
  const last = argv.indexOf('-o'); if (last >= 0) await writeFile(argv[last + 1], output);
} else emit({ type: 'result', subtype: 'success', session_id: id, result: output, ...(argv.includes('--json-schema') ? { structured_output: JSON.parse(output) } : {}), usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.001 });
