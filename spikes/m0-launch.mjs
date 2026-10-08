// Run after npm run build. Real CLI qualification; outputs are ignored by Git.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults } from '../dist/src/hub/config.js';
import { probeBackends } from '../dist/src/hub/capabilities.js';
import { launchTurn } from '../dist/src/backends/procs.js';

const directory = path.resolve(process.argv[2] ?? `spikes/artifacts/m0-${Date.now()}`);
await mkdir(directory, { recursive: true });
const config = defaults(); const backends = await probeBackends(config);
const fixture = path.resolve('spikes/m0-fixture.mjs');
const nonce = randomUUID();
const summary = { at: new Date().toISOString(), backends, tests: {} };
const contract = 'task: Run only the requested probe.\nconstraints: Do not delegate or access credentials. Do not modify files.\nreply: Raw requested JSON; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:';
for (const backend of process.argv[3] ? [process.argv[3]] : ['claude', 'codex']) {
  const info = backends[backend]; if (!info.available) { summary.tests[backend] = { blocked: info.error }; continue; }
  const cwd = path.join(directory, backend); await mkdir(cwd, { recursive: true });
  const events = path.join(cwd, 'fixture.jsonl');
  const mcpPath = path.join(cwd, 'mcp.json'), settingsPath = path.join(cwd, 'settings.json');
  await writeFile(mcpPath, JSON.stringify({ mcpServers: { stampede: { command: process.execPath, args: [fixture], env: { STAMPEDE_PROBE_EVENTS: events, STAMPEDE_PROBE_NONCE: nonce } } } }));
  await writeFile(settingsPath, JSON.stringify({ enabledPlugins: { 'stampede@stampede': false }, hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" "${fixture}" hook`, timeout: 5 }] }] } }));
  const schema = { type: 'object', properties: { fixture: { type: 'string' }, hookNonce: { type: 'string' }, developerMarker: { type: 'string' } }, required: ['fixture', 'hookNonce', 'developerMarker'], additionalProperties: false };
  const schemaPath = path.join(cwd, 'schema.json'); await writeFile(schemaPath, JSON.stringify(schema));
  const launch = { backend, binary: info.binary, entry: info.entry, cwd, access: 'read-only', model: backend === 'claude' ? 'haiku' : 'gpt-6-luna', effort: 'low', schema, schemaPath, lastMessagePath: path.join(cwd, 'last.txt'), mcpPath, settingsPath, contract: contract + '\nknown: developerMarker=stampede-developer-probe', comms: true, hubUrl: 'http://127.0.0.1:1', token: 'synthetic-fixture-only', cliEntry: fixture, windowsSandbox: 'elevated', timeoutMs: 150000, stdoutPath: path.join(cwd, 'stdout.jsonl'), stderrPath: path.join(cwd, 'stderr.log'), settingSources: '', maxUsd: 0.50, disableHooks: backend === 'codex', extraEnv: { STAMPEDE_PROBE_EVENTS: events, STAMPEDE_PROBE_NONCE: nonce } };
  if (backend === 'codex') {
    launch.mcpEnv = launch.extraEnv;
    launch.disableHooks = false;
    launch.codexHookCommand = `"${process.execPath}" "${fixture}" hook`;
    launch.trustCodexHooks = process.env.STAMPEDE_PROBE_TRUST_HOOKS === '1';
  }
  // The Codex builder calls the fixture with mcp --role agent; it accepts these
  // unused args. Stampede variables are inherited by its MCP fixture process.
  const delay = backend === 'claude' ? 45000 : 0;
  const outcome = await launchTurn(launch, `task: Call the stampede probe tool exactly once with delayMs=${delay}.\nreply: JSON with fixture from the tool, hookNonce from any PostToolUse hook context (empty string if none), and developerMarker from your developer instructions; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:`).done;
  let rows = []; try { rows = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse); } catch {}
  const transcript = (await readFile(launch.stdoutPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const result = outcome.structured ?? (() => { try { return JSON.parse(outcome.text); } catch { return null; } })();
  summary.tests[backend] = { ok: outcome.ok, sessionId: outcome.sessionId, result, error: outcome.error, usage: outcome.usage, fixtureCalled: rows.some(r => r.type === 'tool-call') || transcript.some(r => r.type === 'item.completed' && r.item?.type === 'mcp_tool_call' && r.item?.status === 'completed'), hookObserved: rows.some(r => r.type === 'hook'), hookContextObserved: result?.hookNonce === nonce, developerInstructionsObserved: result?.developerMarker === 'stampede-developer-probe', waitDurationMs: rows.find(r => r.type === 'tool-return')?.at - rows.find(r => r.type === 'tool-call')?.at };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify({ backend, ...summary.tests[backend] }) + '\n');
}
