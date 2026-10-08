import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';
import { claudeArgv } from './claude.js';
import { codexArgv } from './codex.js';
import { classify, zeroUsage, type AgentLaunch, type TurnHandle, type TurnOutcome } from './adapter.js';

export function workerEnv(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if ((key.startsWith('CODEX_') && !['CODEX_HOME', 'CODEX_API_KEY'].includes(key)) || key.startsWith('STAMPEDE_') || key === 'PSModulePath' || key === 'CLAUDECODE') delete env[key];
  return { ...env, ...extra };
}
export function redact(text: string, secrets: string[] = []) {
  for (const value of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(value).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]').replace(/((?:STAMPEDE_\w*TOKEN\w*|Authorization|\w*(?:API_KEY|SECRET|PASSWORD))\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
export async function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    const [code] = await once(killer, 'close');
    if (code !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`could not stop process tree ${child.pid}`);
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 1500))]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}
export function launchTurn(a: AgentLaunch, prompt: string, options: { resumeSessionId?: string; onEvent?: (event: any) => void; onSpawn?: (pid: number) => Promise<void>; onHanded?: () => Promise<void> } = {}): TurnHandle {
  if (a.backend === 'codex' && a.developerInstructionsFlag === false) prompt = `<stampede-contract>\n${a.contract}\n</stampede-contract>\n${prompt}`;
  const argv = a.backend === 'claude' ? claudeArgv(a, options.resumeSessionId) : codexArgv(a, { resumeThreadId: options.resumeSessionId });
  const env = workerEnv({ ...a.extraEnv, STAMPEDE_HUB_URL: a.hubUrl, ...(a.token ? { STAMPEDE_AGENT_TOKEN: a.token } : {}), MCP_TOOL_TIMEOUT: '120000' });
  const secrets = Object.entries(env).filter(([key]) => /(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)).map(([, value]) => value!).filter(Boolean);
  const child = spawn(a.binary, argv, { cwd: a.cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = createWriteStream(a.stdoutPath, { mode: 0o600 });
  const stderr = createWriteStream(a.stderrPath, { mode: 0o600 });
  const result: TurnOutcome = { ok: false, usage: zeroUsage(), code: null };
  let tail = '', buffer = '', errorBuffer = '', cancelled = false, timedOut = false, streamError: Error | undefined;
  let finalSeen = false;
  let handoff = Promise.resolve();
  const decoder = new StringDecoder('utf8');
  const consume = (line: string) => {
    stdout.write(redact(line, secrets) + '\n');
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    try { options.onEvent?.(event); } catch (error) { streamError = error as Error; void killTree(child).catch(() => {}); }
    if (event.type === 'thread.started') result.sessionId = event.thread_id;
    if (event.session_id) result.sessionId = event.session_id;
    if (a.backend === 'claude' && event.type === 'result') {
      finalSeen = true;
      result.ok = event.subtype === 'success' && !event.is_error;
      result.text = event.result; result.structured = event.structured_output;
      const usage = event.usage ?? {};
      result.usage = { inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), cachedInputTokens: usage.cache_read_input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0, usd: event.total_cost_usd ?? null };
      if (!result.ok) result.error = { kind: classify(JSON.stringify(event), event.api_error_status), message: String(event.result ?? event.subtype) };
    }
    if (a.backend === 'codex') {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') { result.text = event.item.text; finalSeen = true; }
      // An `error` event also reports a stream Codex is retrying ("Reconnecting... 2/5"): the turn's own end decides.
      if (event.type === 'turn.completed') { result.ok = true; delete result.error; const u = event.usage ?? {}; result.usage = { inputTokens: u.input_tokens ?? 0, cachedInputTokens: u.cached_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, reasoningTokens: u.reasoning_output_tokens ?? 0, usd: null }; }
      if (event.type === 'error' || event.type === 'turn.failed') result.error = { kind: classify(JSON.stringify(event)), message: String(event.message ?? event.error?.message ?? 'Codex turn failed') };
    }
  };
  child.stdout.on('data', chunk => { buffer += decoder.write(chunk); let i; while ((i = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } if (buffer.length > 8 * 1024 * 1024) { streamError = new Error('backend JSONL record exceeds 8 MiB'); void killTree(child).catch(() => {}); } });
  const errorDecoder = new StringDecoder('utf8');
  const consumeError = (line: string) => { const text = redact(line, secrets); tail = (tail + text).slice(-4096); stderr.write(text); };
  child.stderr.on('data', chunk => {
    errorBuffer += errorDecoder.write(chunk);
    let i; while ((i = errorBuffer.indexOf('\n')) >= 0) { consumeError(errorBuffer.slice(0, i + 1)); errorBuffer = errorBuffer.slice(i + 1); }
    if (errorBuffer.length > 8 * 1024 * 1024) { errorBuffer = ''; streamError = new Error('backend stderr line exceeds 8 MiB'); void killTree(child).catch(() => {}); }
  });
  for (const stream of [stdout, stderr]) stream.on('error', error => { streamError = error; void killTree(child).catch(() => {}); });
  child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') streamError = error; });
  child.once('spawn', () => { handoff = Promise.resolve(options.onSpawn?.(child.pid!)).then(() => new Promise<void>((resolve, reject) => child.stdin.write(prompt, error => { if (error) { reject(error); return; } child.stdin.end(); Promise.resolve(options.onHanded?.()).then(resolve, reject); }))).catch(error => { streamError = error; void killTree(child).catch(() => {}); }); });
  const timer = setTimeout(() => { timedOut = true; void killTree(child).catch(error => { streamError = error; }); }, a.timeoutMs);
  const done = new Promise<TurnOutcome>(resolve => {
    child.once('error', error => { result.error = { kind: 'spawn', message: error.message }; });
    child.once('close', async (code, signal) => {
      clearTimeout(timer); await handoff;
      buffer += decoder.end(); if (buffer.trim()) consume(buffer);
      errorBuffer += errorDecoder.end(); if (errorBuffer) consumeError(errorBuffer);
      await Promise.all([new Promise<void>(r => stdout.end(r)), new Promise<void>(r => stderr.end(r))]);
      if (a.backend === 'codex' && a.lastMessagePath) { try { const text = await readFile(a.lastMessagePath, 'utf8'); if (text) { result.text = text; finalSeen = true; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') streamError = error as Error; } }
      result.code = code; result.signal = signal;
      if (timedOut || cancelled || streamError) result.error = { kind: timedOut ? 'timeout' : cancelled ? 'cancelled' : 'crash', message: streamError?.message ?? (timedOut ? 'turn timed out' : 'turn cancelled') };
      else if (!result.error && (code !== 0 || !finalSeen)) result.error = { kind: code !== 0 ? classify(tail) === 'unknown' ? 'crash' : classify(tail) : 'unknown', message: tail || 'backend exited without final output' };
      result.ok = result.ok && code === 0 && finalSeen && !result.error;
      resolve(result);
    });
  });
  return { done, pid: child.pid, async kill() { cancelled = true; await killTree(child); await done; } };
}
