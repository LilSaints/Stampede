import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';
export interface BackendInfo { available: boolean; binary?: string; entry?: string; version?: string; error?: string; capabilities: Record<string, boolean | string | number> }
export async function capture(file: string, argv: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false;
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 1024 * 1024) { overflow = true; stdout = ''; child.kill(); } });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-8192); });
    const timeout = setTimeout(() => { child.kill(); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); if (overflow) reject(new Error('command output exceeds 1 MiB; refusing truncated data')); else resolve({ code, stdout, stderr }); });
  });
}
export async function findExecutable(name: string) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? `${name}.exe` : name);
    try { await access(file); return file; } catch { /* next PATH directory */ }
  }
  throw new Error(`${name} executable not found on PATH`);
}
function older(version: string, minimum: string) {
  const a = version.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
export async function probeBackends(config: Config): Promise<Record<'claude' | 'codex', BackendInfo>> {
  async function probe(name: 'claude' | 'codex'): Promise<BackendInfo> {
    let binary: string | undefined, entry: string | undefined;
    try {
      if (name === 'claude') binary = config.claude.binary ?? await findExecutable('claude');
      else {
        const candidates = [config.codex.entry, path.join(process.env.APPDATA ?? path.join(os.homedir(), '.npm-global'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...((process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')))];
        for (const candidate of candidates) if (candidate) { try { await access(candidate); entry = candidate; break; } catch {} }
        if (entry) binary = process.execPath; else binary = await findExecutable('codex');
      }
      const result = await capture(binary, [...(entry ? [entry] : []), '--version']);
      const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0];
      if (result.code !== 0 || !version) throw new Error(result.stderr || 'cannot determine backend version');
      if (older(version, name === 'claude' ? '2.1.292' : '0.159.2') && !config.allowUntestedVersions) throw new Error(`backend ${version} is below tested minimum`);
      // Only the exact builds qualified by spikes/RESULTS.md inherit observed
      // capabilities. A newer version requires requalification, not guesswork.
      const qualified = version === (name === 'claude' ? '2.1.292' : '0.159.2');
      return { available: true, binary, entry, version, capabilities: name === 'claude' ? { qualified, hooksEnvInherited: qualified, liveMidTurn: false } : { qualified, hooksViaFlags: false, hookTrustRequired: false, developerInstructionsFlag: qualified, mcpViaFlags: qualified, strictSchema: true, concurrentHomeSafe: qualified, testedConcurrency: qualified ? 8 : 0 } };
    } catch (error) { return { available: false, binary, entry, error: (error as Error).message, capabilities: {} }; }
  }
  const [claude, codex] = await Promise.all([probe('claude'), probe('codex')]);
  return { claude, codex };
}
