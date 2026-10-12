import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from '../hub/config.js';
import { readJson } from '../hub/store.js';
/**
 * Starts the hub in a process of its own that outlives the one asking. A
 * detached spawn stays in its launcher's Windows job and process tree, so an
 * app update or a session ending (which ends that job or tree) kills the hub
 * and the runs it holds. On Windows the hub is created through WMI instead
 * (Win32_Process.Create), outside both, hidden and with this process's
 * environment; if that fails, the detached spawn still starts it.
 */
export async function launchHub(cliEntry: string, home: string) {
  const env = { ...process.env, STAMPEDE_HOME: home };
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$vars = [string[]](Get-ChildItem env: | Where-Object { $_.Name -notlike 'STAMPEDE_LAUNCH_*' } | ForEach-Object { \"$($_.Name)=$($_.Value)\" })",
      '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $vars }',
      '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:STAMPEDE_LAUNCH_COMMAND; CurrentDirectory = $env:STAMPEDE_LAUNCH_DIR; ProcessStartupInformation = $startup }',
      'if ($result.ReturnValue -ne 0) { [Console]::Error.Write("Win32_Process.Create returned $($result.ReturnValue)"); exit 1 }',
      '[Console]::Out.Write($result.ProcessId)'
    ].join('\n');
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const launched = await new Promise<boolean>(resolve => execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...env, STAMPEDE_LAUNCH_COMMAND: `"${process.execPath}" "${cliEntry}" hub`, STAMPEDE_LAUNCH_DIR: os.homedir() }, windowsHide: true, timeout: 30000
    }, (error, stdout) => resolve(!error && /^\d+$/.test(String(stdout).trim()))));
    if (launched) return;
  }
  spawn(process.execPath, [cliEntry, 'hub'], { detached: true, stdio: 'ignore', windowsHide: true, shell: false, env }).unref();
}
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
    const url = `http://127.0.0.1:${hub.port}`, token = (await readFile(path.join(this.home, 'hub.token'), 'utf8')).trim();
    // The descriptor outlives its hub, which leaves it behind on exit: only a
    // hub that answers counts, and its own version decides, so a stopped older
    // hub is no hub (one is started) while a live one still blocks.
    const health = await fetch(url + '/health', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
      .then(response => response.ok ? response.json() as Promise<{ version?: string }> : undefined, () => undefined);
    if (!health) throw new Error('hub not running');
    if (health.version !== VERSION) throw new Error(`blocked: hub version ${health.version}, shim version ${VERSION}. If this plugin is the newer one, restart the hub once no run is active: node "${this.cliEntry}" hub --restart --detach. If the hub is newer, run /reload-plugins or restart this session`);
    this.url = url; this.token = token;
  }
  async connect(autoStart = true) {
    if (this.role === 'agent') return;
    try { await this.discover(); return; }
    catch (error) { if ((error as Error).message.startsWith('blocked:') || !autoStart) throw error; }
    await launchHub(this.cliEntry, this.home);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { await this.discover(); return; } catch (error) { if ((error as Error).message.startsWith('blocked:')) throw error; }
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
        // Rediscover for the next call, but never duplicate an unknown outcome:
        // only a refused connection (a hub restarted on another port) proves
        // the request never arrived, so only then, or for a read, send it again.
        if (input === undefined || (error as any)?.cause?.code === 'ECONNREFUSED') return this.request(route, input, false);
      }
      throw error;
    }
  }
  tool(name: string, input: any) { return this.request(`/v1/${this.role === 'agent' ? 'agent' : 'orch'}/${name}`, input); }
}
