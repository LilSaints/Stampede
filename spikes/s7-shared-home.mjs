// Eight isolated conversations share the existing CODEX_HOME over three waves.
// Wave 1 starts them; waves 2 and 3 resume the exact corresponding thread IDs.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults } from '../dist/src/hub/config.js';
import { probeBackends } from '../dist/src/hub/capabilities.js';
import { launchTurn } from '../dist/src/backends/procs.js';
const directory = path.resolve(process.argv[2] ?? `spikes/artifacts/s7-${Date.now()}`);
await mkdir(directory, { recursive: true });
const backend = (await probeBackends(defaults())).codex;
if (!backend.available) throw new Error(backend.error);
const schema = { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false };
const sessions = Array.from({ length: 8 }, () => ({ nonce: randomUUID(), id: undefined }));
const results = [];
for (let round = 0; round < 3; round++) {
  const wave = await Promise.all(sessions.map(async (session, i) => {
    const cwd = path.join(directory, String(i)); await mkdir(cwd, { recursive: true });
    const schemaPath = path.join(cwd, 'schema.json'); await writeFile(schemaPath, JSON.stringify(schema));
    const launch = { backend: 'codex', binary: backend.binary, entry: backend.entry, cwd, access: 'read-only', model: 'gpt-6-luna', effort: 'low', schemaPath, mcpPath: '', settingsPath: '', contract: 'task: Answer the requested memory probe.\nconstraints: Do not use tools, delegate, read or modify files.\nreply: Only the requested JSON; if a tool call errors or is interrupted, say so; never report a value you did not observe; use blocked:', comms: false, hubUrl: '', cliEntry: '', windowsSandbox: 'elevated', timeoutMs: 120000, stdoutPath: path.join(cwd, `${round}.stdout.jsonl`), stderrPath: path.join(cwd, `${round}.stderr.log`), lastMessagePath: path.join(cwd, `${round}.last.txt`), disableHooks: true };
    const prompt = round === 0 ? `Remember this conversation nonce: ${session.nonce}. Return it in {"nonce":"..."}.` : 'Return the original nonce from the first user message as {"nonce":"..."}.';
    const outcome = await launchTurn(launch, prompt, { resumeSessionId: session.id }).done;
    let value; try { value = JSON.parse(outcome.text); } catch {}
    const sameSession = !session.id || outcome.sessionId === session.id;
    session.id ??= outcome.sessionId;
    const stderr = await readFile(launch.stderrPath, 'utf8');
    return { round, worker: i, sessionId: outcome.sessionId, ok: outcome.ok && value?.nonce === session.nonce && sameSession, backendOk: outcome.ok, nonceMatched: value?.nonce === session.nonce, sameSession, databaseError: /database is locked|database disk image is malformed|SQLITE_BUSY|corrupt.*database/i.test(stderr), error: outcome.error, usage: outcome.usage };
  }));
  results.push(...wave);
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ version: backend.version, sharedHome: true, concurrency: 8, results, passed: results.length === 24 && results.every(r => r.ok && !r.databaseError) }, null, 2));
  process.stdout.write(JSON.stringify({ round, passed: wave.filter(r => r.ok && !r.databaseError).length, total: 8, errors: wave.filter(r => !r.ok || r.databaseError) }) + '\n');
  if (wave.some(r => !r.ok)) break;
}
