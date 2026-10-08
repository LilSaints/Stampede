import os from 'node:os';
import path from 'node:path';
import { readJson } from './store.js';
export const VERSION = '1.0.0-rc.3';
export const UI_API_VERSION = 1;
export function defaults() {
  const concurrency = Math.max(1, Math.min(16, os.cpus().length - 2, Math.floor(os.freemem() / (0.6 * 1024 ** 3))));
  return {
    defaultBackend: 'claude' as 'claude' | 'codex', allowFullAccess: false, allowUntestedVersions: false,
    hub: { idleShutdownMin: 30 },
    scheduler: { maxConcurrent: concurrency, perRun: Math.max(1, Math.min(16, os.cpus().length - 2)), claude: { maxConcurrent: 8 }, codex: { maxConcurrent: 6 }, nonCommsReserve: 1, admissionMaxMs: 600000 },
    claude: { binary: null as string | null, settingSources: 'user,project,local', isolateUserHooks: false, inheritMcpServers: false, persistNonComms: true, editShellAllow: [] as string[] },
    codex: { entry: null as string | null, defaultModel: 'gpt-6-astra', defaultEffort: 'max', windowsSandbox: 'elevated', agentTypes: {} as Record<string, { developerInstructions: string; model?: string; effort?: string }>, disableUserHooks: false },
    security: { ancestryCheck: process.platform !== 'darwin' },
    cache: { maxFingerprintFiles: 20000, maxFingerprintBytes: 536870912, fingerprintTtlMs: 2000 },
    pricing: { codex: null as Record<string, { inputPerMTok: number; cachedPerMTok: number; outputPerMTok: number }> | null },
    delivery: { resumeDebounceMs: 1500, hookBatchMax: 10, claimLeaseMs: 10000 },
    limits: { drainMs: 120000, turnTimeoutMs: 1800000, maxResumesPerAgent: 20, maxStopBlocks: 5, messagesPerAgent: 100, messagesPerRun: 2000, messageBytes: 16384, teamMaxMs: 7200000, teamMaxMessages: 500, schemaRepairs: 2, scriptCpuBlockMs: 10000, claudeTurnMaxUsd: null as number | null },
    store: { retentionDays: 30, keepSummaries: true, fsync: 'batch-50ms' },
    ui: { pollMs: 1000, idlePollMs: 10000, recentRunsMin: 60, wakeDebounceMs: 3000, maxWakesPerHour: 12 }
  };
}
export type Config = ReturnType<typeof defaults>;
export function stampedeHome() {
  const configured = process.env.STAMPEDE_PLUGIN_HOME?.trim() || process.env.STAMPEDE_HOME?.trim();
  if (configured?.includes('${')) throw new Error('unresolved Stampede plugin home option');
  return path.resolve(configured || path.join(os.homedir(), '.stampede'));
}
function merge(base: any, extra: any, location = ''): any {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error(`invalid configuration at ${location || 'root'}`);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(extra)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('invalid configuration key');
    if (!Object.hasOwn(base, key)) throw new Error(`unknown configuration: ${location}${key}`);
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !['agentTypes'].includes(key)) output[key] = merge(base[key], value, `${location}${key}.`);
    else output[key] = value;
  }
  return output;
}
export function validateConfig(config: Config) {
  if (config.scheduler.maxConcurrent === null) config.scheduler.maxConcurrent = defaults().scheduler.maxConcurrent;
  function shape(value: any, template: any, name: string) {
    if (template === null) return;
    if (Array.isArray(template)) { if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`invalid ${name}`); return; }
    if (typeof template === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
      for (const [key, sample] of Object.entries(template)) shape(value[key], sample, name ? `${name}.${key}` : key);
    } else if (typeof value !== typeof template || typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error(`invalid ${name}`);
  }
  shape(config, defaults(), '');
  for (const [name, value] of [['claude.binary', config.claude.binary], ['codex.entry', config.codex.entry]] as const) if (value !== null && (typeof value !== 'string' || !value)) throw new Error(`invalid ${name}`);
  for (const [name, value] of Object.entries(config.scheduler)) {
    if (typeof value === 'object') { if (!Number.isInteger(value.maxConcurrent) || value.maxConcurrent < 1) throw new Error(`invalid scheduler.${name}`); }
    else if (!Number.isInteger(value) || value < 1) throw new Error(`invalid scheduler.${name}`);
  }
  if (config.scheduler.nonCommsReserve > Math.min(config.scheduler.maxConcurrent, config.scheduler.perRun, config.scheduler.claude.maxConcurrent, config.scheduler.codex.maxConcurrent)) throw new Error('nonCommsReserve must fit every cap');
  for (const [name, value] of Object.entries(config.codex.agentTypes)) {
    if (!value || typeof value.developerInstructions !== 'string' || Object.keys(value).some(key => !['developerInstructions', 'model', 'effort'].includes(key))) throw new Error(`invalid codex.agentTypes.${name}`);
    if (value.model !== undefined && typeof value.model !== 'string' || value.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort)) throw new Error(`invalid codex.agentTypes.${name}`);
  }
  if (config.pricing.codex !== null) {
    if (typeof config.pricing.codex !== 'object' || Array.isArray(config.pricing.codex)) throw new Error('invalid pricing.codex');
    for (const rate of Object.values(config.pricing.codex)) for (const key of ['inputPerMTok', 'cachedPerMTok', 'outputPerMTok'] as const) if (!rate || !Number.isFinite(rate[key]) || rate[key] < 0) throw new Error('invalid codex token pricing');
  }
  if (!['claude', 'codex'].includes(config.defaultBackend)) throw new Error('invalid defaultBackend');
  if (!['elevated', 'unelevated', 'mxc'].includes(config.codex.windowsSandbox)) throw new Error('invalid codex.windowsSandbox');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(config.codex.defaultEffort)) throw new Error('invalid codex.defaultEffort');
  for (const [key, value] of Object.entries(config.limits)) if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`invalid limits.${key}`);
  for (const key of ['turnTimeoutMs', 'scriptCpuBlockMs', 'drainMs'] as const) if (config.limits[key] <= 0) throw new Error(`limits.${key} must be positive`);
  for (const value of [config.hub.idleShutdownMin, config.ui.pollMs, config.ui.idlePollMs, config.delivery.claimLeaseMs]) if (value <= 0) throw new Error('timer intervals must be positive');
  if (!Array.isArray(config.claude.editShellAllow)) throw new Error('invalid editShellAllow');
  for (const rule of config.claude.editShellAllow) {
    if (typeof rule !== 'string' || !/^(Bash|PowerShell)\(.+\)$/.test(rule)) throw new Error(`invalid shell permission rule: ${rule}`);
    if (!config.allowFullAccess && /^(?:PowerShell\(\*|Bash\((?:\*|(?:node|python\d*|pwsh|powershell|cmd|cat|type|npx|bash|sh)(?::|\s|\))))/i.test(rule)) throw new Error(`unsafe editShellAllow requires allowFullAccess: ${rule}`);
  }
  return config;
}
export async function loadConfig(home: string) {
  const base = defaults();
  const config = validateConfig(merge(base, await readJson(path.join(home, 'config.json')) ?? {}));
  // The Workflow per-run ceiling is a backstop, even when home configuration
  // raises the global/backend pools. Project overrides may still lower it.
  config.scheduler.perRun = Math.min(config.scheduler.perRun, base.scheduler.perRun);
  return validateConfig(config);
}
/** Project and run overrides are allowed only to reduce numeric safety limits. */
export function lowerConfig(base: Config, overrides: any): Config {
  const result = structuredClone(base);
  function lower(target: any, input: any, location: string) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`invalid override: ${location}`);
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(target, key)) throw new Error(`unknown override: ${location}${key}`);
      if (typeof value === 'number' && typeof target[key] === 'number' && value >= 0 && value <= target[key]) target[key] = value;
      else if (value && typeof value === 'object' && target[key] && typeof target[key] === 'object' && !Array.isArray(value)) lower(target[key], value, `${location}${key}.`);
      else throw new Error(`override may only lower limits: ${location}${key}`);
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!['limits', 'scheduler'].includes(key)) throw new Error(`project may only lower limits: ${key}`);
    lower((result as any)[key], value, `${key}.`);
  }
  // Reducing the non-comms reserve weakens the progress guarantee.
  if (result.scheduler.nonCommsReserve !== base.scheduler.nonCommsReserve) throw new Error('nonCommsReserve cannot be overridden by projects');
  return validateConfig(result);
}
