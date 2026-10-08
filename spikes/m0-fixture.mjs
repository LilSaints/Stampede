// A finite MCP fixture and hook for the M0 launch qualification. No credentials.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const eventFile = process.env.STAMPEDE_PROBE_EVENTS;
const record = value => { if (eventFile) appendFileSync(eventFile, JSON.stringify({ at: Date.now(), ...value }) + '\n'); };
const nonce = process.env.STAMPEDE_PROBE_NONCE ?? 'missing-env';
if (process.argv[2] === 'hook') {
  let input = ''; for await (const part of process.stdin) input += part;
  const data = JSON.parse(input || '{}');
  record({ type: 'hook', event: data.hook_event_name, nonce, pid: process.pid });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Stampede probe hook nonce: ${nonce}` } }));
} else {
  const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  record({ type: 'mcp-start', pid: process.pid });
  createInterface({ input: process.stdin }).on('line', async line => {
    let request; try { request = JSON.parse(line); } catch { return; }
    const { id, method, params } = request;
    if (method === 'initialize') answer(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stampede-probe', version: '0.0.1' } });
    else if (method === 'tools/list') answer(id, { tools: [{ name: 'probe', description: 'Return a fixture value after the requested delay (milliseconds).', inputSchema: { type: 'object', properties: { delayMs: { type: 'integer', minimum: 0, maximum: 55000 } } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } }] });
    else if (method === 'tools/call') {
      record({ type: 'tool-call', name: params.name, input: params.arguments });
      await new Promise(resolve => setTimeout(resolve, Math.min(55000, Math.max(0, params.arguments?.delayMs ?? 0))));
      answer(id, { content: [{ type: 'text', text: JSON.stringify({ fixture: 'ok' }) }] });
      record({ type: 'tool-return' });
    } else if (id !== undefined) answer(id, {});
  });
}
