import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, chmod, readdir, lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { findExecutable } from './capabilities.js';
import { Mutex } from './workspaces.js';
export interface Identity { pid: number; startFileTime: string; image?: string; parentPid?: number }
export class Security {
  private helper?: ChildProcessWithoutNullStreams;
  private pending: { resolve: (value: any) => void; reject: (e: Error) => void }[] = [];
  private roots = new Map<number, Identity>();
  private mutex = new Mutex();
  aclVerified = false;
  ancestryActive = false;
  warnings: string[] = [];
  async start(home: string, ancestry: boolean) {
    const resolved = path.resolve(home);
    if ([path.parse(resolved).root, os.homedir()].some(p => path.resolve(p).toLowerCase() === resolved.toLowerCase())) throw new Error('refusing broad state directory');
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      try {
        const binary = await findExecutable('pwsh').catch(() => findExecutable('powershell'));
        this.helper = spawn(binary, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../../../src/hub/windows-helper.ps1', import.meta.url)), '-Serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PSModulePath: '' } });
        let tail = '';
        this.helper.stderr.on('data', d => { tail = (tail + d).slice(-2000); });
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('security helper startup timeout')), 10000);
          createInterface({ input: this.helper!.stdout }).on('line', line => {
            try { const result = JSON.parse(line); if (result.ready) { clearTimeout(timeout); resolve(); } else this.pending.shift()?.resolve(result); }
            catch { this.pending.shift()?.reject(new Error('invalid security helper response')); }
          });
          this.helper!.once('error', error => { clearTimeout(timeout); reject(error); });
          this.helper!.once('exit', code => { clearTimeout(timeout); const error = new Error(`security helper exited ${code}: ${tail}`); this.ancestryActive = false; reject(error); for (const p of this.pending.splice(0)) p.reject(error); });
        });
        const result = await this.query({ protectState: home });
        if (!result.ok || !result.acl?.verified) throw new Error(result.error ?? 'state ACL verification failed');
        this.aclVerified = true; this.ancestryActive = ancestry;
      } catch (error) { this.warnings.push((error as Error).message); this.helper?.kill(); this.helper = undefined; throw new Error(`cannot protect Stampede state: ${(error as Error).message}`); }
    } else {
      const walk = async (directory: string) => {
        if ((await lstat(directory)).isSymbolicLink()) throw new Error('state directory contains symbolic link');
        await chmod(directory, 0o700);
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (item.isSymbolicLink()) throw new Error('state directory contains symbolic link');
          if (item.isDirectory()) await walk(path.join(directory, item.name)); else await chmod(path.join(directory, item.name), 0o600);
        }
      };
      await walk(home); this.aclVerified = true;
      this.ancestryActive = ancestry && process.platform === 'linux';
      if (ancestry && !this.ancestryActive) this.warnings.push('process ancestry checks unavailable on this platform');
    }
  }
  private query(input: unknown) {
    return this.mutex.run(() => new Promise<any>((resolve, reject) => {
      if (!this.helper || this.helper.exitCode !== null) { reject(new Error('security helper unavailable')); return; }
      const timeout = setTimeout(() => { this.helper?.kill(); reject(new Error('security lookup timeout')); }, 5000);
      this.pending.push({ resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.helper.stdin.write(JSON.stringify(input) + '\n');
    }));
  }
  async identity(pid: number): Promise<Identity | undefined> {
    try {
      if (process.platform === 'win32') { const result = await this.query({ inspectPid: pid }); return result.ok ? result.identity : undefined; }
      if (process.platform === 'linux') {
        const text = await readFile(`/proc/${pid}/stat`, 'utf8'); const end = text.lastIndexOf(')'); const fields = text.slice(end + 2).split(' ');
        return { pid, parentPid: Number(fields[1]), startFileTime: fields[19], image: text.slice(text.indexOf('(') + 1, end) };
      }
    } catch { return undefined; }
  }
  async track(pid: number) { const identity = await this.identity(pid); if (identity) this.roots.set(pid, identity); return identity; }
  async killVerified(expected: Identity) {
    if (!expected.startFileTime || expected.pid === process.pid) return false;
    if (process.platform === 'win32') {
      const result = await this.query({ killIdentity: expected });
      if (!result.ok) throw new Error(result.error);
      return Boolean(result.killed);
    }
    const actual = await this.identity(expected.pid);
    if (actual?.startFileTime !== expected.startFileTime) return false;
    try { process.kill(-expected.pid, 'SIGKILL'); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }
  async allowed(clientPort: number, serverPort: number): Promise<{ allowed: boolean; client?: Identity }> {
    if (!this.ancestryActive) return { allowed: true };
    try {
      let chain: Identity[] = [];
      if (process.platform === 'win32') { const result = await this.query({ clientPort, serverPort }); if (!result.ok) throw new Error(result.error); chain = result.chain; }
      else {
        const rows = (await readFile('/proc/net/tcp', 'utf8')).split('\n').slice(1).map(l => l.trim().split(/\s+/));
        const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
        const row = rows.find(r => r[1] === `0100007F:${hex(clientPort)}` && r[2] === `0100007F:${hex(serverPort)}` && r[3] === '01');
        if (!row) throw new Error('client TCP tuple unavailable');
        const inode = `socket:[${row[9]}]`;
        const { readlink } = await import('node:fs/promises');
        let client: number | undefined;
        for (const pid of (await readdir('/proc')).filter(p => /^\d+$/.test(p))) {
          try { for (const fd of await readdir(`/proc/${pid}/fd`)) if (await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '') === inode) { client = Number(pid); break; } } catch {}
          if (client) break;
        }
        let current = client ? await this.identity(client) : undefined;
        while (current && !chain.some(p => p.pid === current!.pid)) { chain.push(current); const parent: Identity | undefined = current.parentPid ? await this.identity(current.parentPid) : undefined; if (!parent || BigInt(parent.startFileTime) > BigInt(current.startFileTime)) break; current = parent; }
      }
      return { client: chain[0], allowed: !chain.some(p => this.roots.get(p.pid)?.startFileTime === p.startFileTime) };
    } catch (error) { const warning = `ancestry lookup unavailable: ${(error as Error).message}`; if (!this.warnings.includes(warning)) this.warnings.push(warning); return { allowed: true }; }
  }
  async close() { this.helper?.stdin.end(); }
}
