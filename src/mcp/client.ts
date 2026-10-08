import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from '../hub/config.js';
import { readJson } from '../hub/store.js';
export class HubClient {
  private url?: string;
  private token?: string;
  constructor(readonly home: string, readonly cliEntry: string, readonly role: 'agent' | 'orchestrator') {
    if (role === 'orchestrator' && process.env.STAMPEDE_AGENT_TOKEN) throw new Error('worker cannot start an orchestrator shim');
    if (role === 'agent') { this.url = process.env.STAMPEDE_HUB_URL; this.token = process.env.STAMPEDE_AGENT_TOKEN; if (!this.url || !this.token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(this.url)) throw new Error('missing or invalid agent identity'); }
  }
  private async discover() {
    const hub = await readJson<{ port: number; version: string }>(path.join(this.home, 'hub.json'));
    if (!hub) throw new Error('hub not running');
    if (!Number.isInteger(hub.port) || hub.port < 1 || hub.port > 65535) throw new Error('invalid hub port');
    if (hub.version !== VERSION) throw new Error(`blocked: hub version ${hub.version}, shim version ${VERSION}; run 'stampede hub --restart' after runs finish`);
    this.url = `http://127.0.0.1:${hub.port}`;
    this.token = (await readFile(path.join(this.home, 'hub.token'), 'utf8')).trim();
  }
  async connect(autoStart = true) {
    if (this.role === 'agent') return;
    try { await this.discover(); await this.request('/health', undefined, false); return; }
    catch (error) { if ((error as Error).message.startsWith('blocked:') || !autoStart) throw error; }
    const child = spawn(process.execPath, [this.cliEntry, 'hub'], { detached: true, stdio: 'ignore', windowsHide: true, shell: false, env: { ...process.env, STAMPEDE_HOME: this.home } });
    child.unref();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { await this.discover(); await this.request('/health', undefined, false); return; } catch (error) { if ((error as Error).message.startsWith('blocked:')) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('hub failed to start within 10 seconds; run stampede doctor');
  }
  async request(route: string, input?: unknown, retry = true): Promise<any> {
    try {
      const response = await fetch(this.url + route, { method: input === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(60000) });
      if (response.status === 401 && retry && this.role === 'orchestrator') { await this.discover(); return this.request(route, input, false); }
      const value = await response.json() as any;
      if (!response.ok) throw Object.assign(new Error(value.error ?? `HTTP ${response.status}`), { code: value.code, httpStatus: response.status });
      return value;
    } catch (error) {
      if (retry && this.role === 'orchestrator' && !(error as any).httpStatus) {
        await this.discover();
        // A lost POST response does not establish that the mutation failed.
        // Rediscover for the next call, but never duplicate an unknown outcome.
        if (input === undefined) return this.request(route, input, false);
      }
      throw error;
    }
  }
  tool(name: string, input: any) { return this.request(`/v1/${this.role === 'agent' ? 'agent' : 'orch'}/${name}`, input); }
}
