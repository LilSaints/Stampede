import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { HubClient } from './client.js';
import { agentTools, orchestratorTools, validateTool } from './tools.js';
import { VERSION } from '../hub/config.js';

export async function startShim(home: string, entry: string, role: 'agent' | 'orchestrator') {
  const client = new HubClient(home, entry, role);
  // A hub this shim cannot use (another version, or none that starts) is said by
  // each tool call, which tries it again: a server that never answers shows only
  // as "Connection closed".
  const connect = () => client.connect().then(() => undefined, (error: Error) => error);
  let unusable = await connect();
  const claims = new Map<string | number, string>();
  class AcknowledgedTransport extends StdioServerTransport {
    override async send(message: JSONRPCMessage) {
      // SDK's default send resolves on buffering/drain, not the stdout write
      // callback. Delivery handoff specifically requires the latter.
      await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve()));
      if ('id' in message && message.id !== undefined) {
        const claimId = claims.get(message.id);
        if (claimId) { claims.delete(message.id); try { await client.request('/v1/agent/claim-ack', { claimId }); } catch { /* lease expiry redelivers */ } }
      }
    }
  }
  const server = new Server({ name: 'stampede', version: VERSION }, { capabilities: { tools: {} } });
  // A worker lists the tools the hub gave it (STAMPEDE_AGENT_TOOLS); the hub refuses any other.
  const allowed = process.env.STAMPEDE_AGENT_TOOLS?.split(',');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: role === 'agent' ? agentTools.filter(tool => !allowed || allowed.includes(tool.name)) : orchestratorTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (unusable && (unusable = await connect())) throw Object.assign(new Error(unusable.message), { code: unusable.message.startsWith('blocked:') ? 'version_mismatch' : 'hub_unavailable' });
      const input = request.params.arguments ?? {}; validateTool(request.params.name, input, role);
      if (role === 'orchestrator' && request.params.name === 'workflow_run' && !input.cwd) input.cwd = process.cwd();
      const result = await client.tool(request.params.name, input);
      if (role === 'agent' && result.claimId) claims.set(extra.requestId, result.claimId);
      const { claimId, deliveries, ...visible } = result;
      if (deliveries && visible.messages) visible.messages = visible.messages.map((message: any) => ({ ...message, redelivered: deliveries.some((delivery: any) => delivery.seq === message.seq && delivery.redelivered > 0) }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(visible) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: (error as Error).message, code: (error as any).code ?? 'tool_error' }) }] }; }
  });
  await server.connect(new AcknowledgedTransport());
  const heartbeat = role === 'orchestrator' ? setInterval(() => { void client.request('/health').catch(() => {}); }, 60000) : undefined;
  heartbeat?.unref();
  server.onclose = () => clearInterval(heartbeat);
  process.stdin.once('end', () => { clearInterval(heartbeat); void server.close(); });
  return server;
}
