import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHub } from '../../src/hub/server.js';
import { defaults } from '../../src/hub/config.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error('fault fixture timed out'); await sleep(10); }
}
test('lost HTTP responses and killed shims, hooks and workers replay ordered flagged messages', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stampede-faults-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const config = defaults(); config.defaultBackend = 'codex'; config.delivery.claimLeaseMs = 500;
  config.scheduler.maxConcurrent = 4; config.scheduler.perRun = 4; config.scheduler.codex.maxConcurrent = 3;
  const fake = { available: true, binary: process.execPath, entry: path.resolve('test/fake-backends/fake-codex.mjs'), version: '0.159.2', capabilities: {} };
  const hub = await startHub({ home: path.join(root, 'state'), config, cliEntry: path.resolve('dist/cli.js'), backends: { codex: fake, claude: { available: false, capabilities: {} } } });
  let fault = '', intercepted = false;
  // Faults are applied at the real HTTP boundary, without production test hooks.
  const proxy = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      if (fault === 'hold-ack' && request.url === '/v1/agent/claim-ack') { intercepted = true; return; }
      const upstream = await fetch(hub.manager.hubUrl + request.url, { method: 'POST', headers: { authorization: request.headers.authorization!, 'content-type': 'application/json' }, body });
      const value = await upstream.text();
      if (fault === 'drop-read' && request.url === '/v1/agent/read_messages') { intercepted = true; response.destroy(); return; }
      if (fault === 'hold-claim' && request.url === '/v1/agent/claim') { intercepted = true; return; }
      response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(value);
    } catch { response.destroy(); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const children: ReturnType<typeof spawn>[] = [];
  const clients: Client[] = [];
  try {
    for (const scenario of ['lost-read-response', 'shim-after-write', 'hook-before-print', 'hook-after-print']) {
      const started = await hub.manager.start({ cwd, script: 'export const meta={name:"fault",description:"delivery boundary"}; await spawnTeam([{name:"receiver",prompt:"hang"}]); await new Promise(()=>{});' });
      const execution = hub.manager.active.get(started.runId)!;
      await until(() => execution.run.agents[0]?.status === 'running');
      const context = execution.contexts.get('receiver')!;
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>, STAMPEDE_HUB_URL: proxyUrl, STAMPEDE_AGENT_TOKEN: context.token };
      const messages = [];
      for (let i = 0; i < 3; i++) messages.push(await execution.sendOrchestrator('receiver', `${scenario}-${i}`));
      const seqs = messages.map(message => message.seq);
      const connect = async () => {
        const client = new Client({ name: 'fault-fixture', version: '1' }); clients.push(client);
        const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.js'), 'mcp', '--role', 'agent'], env, stderr: 'pipe' });
        transport.stderr?.on('data', () => {});
        await client.connect(transport); return { client, transport };
      };
      const read = async (client: Client) => client.callTool({ name: 'read_messages', arguments: { max: 3 } });
      const visible = (result: Awaited<ReturnType<typeof read>>) => JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text);
      intercepted = false;
      if (scenario.startsWith('hook')) {
        fault = scenario === 'hook-before-print' ? 'hold-claim' : 'hold-ack';
        const child = spawn(process.execPath, [path.resolve('dist/hook.js'), 'post-tool-use', '--backend', 'claude'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
        let printed = ''; child.stdout!.on('data', chunk => { printed += chunk; }); child.stderr!.resume(); child.stdin!.end('{}');
        await until(() => intercepted);
        if (scenario === 'hook-before-print') assert.equal(printed, '');
        else { await until(() => printed.includes(`${scenario}-2`)); assert.ok(printed.indexOf(`${scenario}-0`) < printed.indexOf(`${scenario}-1`)); }
        const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
      } else {
        const { client, transport } = await connect();
        fault = scenario === 'lost-read-response' ? 'drop-read' : 'hold-ack';
        const response = await read(client);
        if (scenario === 'lost-read-response') assert.equal(response.isError, true);
        else { assert.deepEqual(visible(response).messages.map((m: any) => m.seq), seqs); await until(() => intercepted); process.kill(transport.pid!, 'SIGKILL'); }
        await client.close();
      }
      assert.equal(intercepted, true);
      fault = '';
      await until(() => execution.bus.deliveries.every(d => d.state === 'pending'));
      const { client } = await connect();
      const recovered = visible(await read(client));
      assert.deepEqual(recovered.messages.map((m: any) => m.seq), seqs);
      assert.ok(recovered.messages.every((m: any) => m.redelivered));
      await until(() => execution.bus.deliveries.every(d => d.state === 'handed'));
      await client.close();
      // Kill the actual backend after handoff. The retry receives the same
      // ordered suffix in stdin; normal completion is the only commit point.
      await execution.controlAgent('receiver', 'retry');
      await until(() => context.agent.resultStoredAtTurn === 2 && context.agent.status === 'idle');
      const result = String(context.agent.result);
      for (let i = 0; i < 3; i++) assert.match(result, new RegExp(`${scenario}-${i}`));
      assert.ok(result.indexOf(`${scenario}-0`) < result.indexOf(`${scenario}-1`));
      assert.ok(result.indexOf(`${scenario}-1`) < result.indexOf(`${scenario}-2`));
      assert.match(result, /redelivered="true"/);
      assert.ok(execution.bus.deliveries.every(d => d.state === 'committed'));
      await hub.manager.control(started.runId, 'cancel');
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(clients.map(client => client.close()));
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
