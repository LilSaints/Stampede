import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaults } from '../dist/src/hub/config.js';
import { probeBackends, capture } from '../dist/src/hub/capabilities.js';
import { launchTurn, workerEnv } from '../dist/src/backends/procs.js';
const directory = path.resolve(process.argv[2] ?? `spikes/artifacts/s6-s9-${Date.now()}`);
await mkdir(directory, { recursive: true });
const backends = await probeBackends(defaults());
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const schemaPath = path.join(directory, 'schema.json'); await writeFile(schemaPath, JSON.stringify(schema));
const mcpPath = path.join(directory, 'mcp.json'); await writeFile(mcpPath, '{"mcpServers":{}}');
const results = { at: new Date().toISOString(), versions: Object.fromEntries(Object.entries(backends).map(([k,v])=>[k,v.version])), schemaFile: [], efforts: [] };
if (backends.claude.available) for (const argument of [schemaPath, '@' + schemaPath]) {
  const outcome = await capture(backends.claude.binary, ['-p', '--json-schema', argument, '--model', 'haiku', '--effort', 'low', '--max-budget-usd', '0.05', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcpPath, '--', 'Return {"ok":true}.'], directory, workerEnv());
  results.schemaFile.push({ form: argument.startsWith('@') ? '@file' : 'file', code: outcome.code, output: outcome.stdout.slice(-1000), error: outcome.stderr.slice(-1000) });
}
if (backends.codex.available && process.argv[3] !== 'schema') for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
  const launch = { backend: 'codex', binary: backends.codex.binary, entry: backends.codex.entry, cwd: directory, access: 'read-only', model: 'gpt-6-astra', effort, schemaPath, mcpPath, settingsPath: '', contract: 'task: Return the requested constant JSON.\nconstraints: Do not use tools or delegate.\nreply: JSON only; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:', comms: false, hubUrl: '', cliEntry: '', windowsSandbox: 'elevated', timeoutMs: 90000, stdoutPath: path.join(directory, `${effort}.stdout.jsonl`), stderrPath: path.join(directory, `${effort}.stderr.log`), lastMessagePath: path.join(directory, `${effort}.last.txt`), disableHooks: true };
  const outcome = await launchTurn(launch, 'Return {"ok":true}.').done;
  let value; try { value = JSON.parse(outcome.text); } catch {}
  results.efforts.push({ effort, ok: outcome.ok && value?.ok === true, error: outcome.error, usage: outcome.usage });
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(results, null, 2));
  process.stdout.write(JSON.stringify(results.efforts.at(-1)) + '\n');
}
await writeFile(path.join(directory, 'summary.json'), JSON.stringify(results, null, 2));
process.stdout.write(JSON.stringify({ schemaFile: results.schemaFile }) + '\n');
