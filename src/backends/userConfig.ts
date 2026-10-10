import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';

/**
 * What an agent's call takes from the user's own Claude Code and Codex
 * configuration: MCP servers by name, and the plugins it turns on or off.
 * Workers otherwise load no MCP server but Stampede's (--strict-mcp-config,
 * Codex's --ignore-user-config).
 */
/** An MCP server in Claude Code's shape: `{ type?: 'stdio', command, args?, env? }` or `{ type: 'http' | 'sse', url, headers? }`. */
export type McpServer = Record<string, unknown>;
export type McpServerEntry = string | Record<string, McpServer>;
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PLUGIN_ID = /^[A-Za-z0-9._-]{1,128}(?:@[A-Za-z0-9._-]{1,128})?$/;
const STAMPEDE_PLUGIN = 'stampede@stampede';
const isMap = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringMap = (value: unknown) => isMap(value) && Object.values(value).every(v => typeof v === 'string');
const readJsonFile = async (file: string) => JSON.parse(await readFile(file, 'utf8').catch(() => 'null')) as any;
/** Claude Code's files: `.claude.json` (user and local MCP scopes) and the user settings folder, both moved by CLAUDE_CONFIG_DIR. */
export function claudeFiles(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const dir = env.CLAUDE_CONFIG_DIR;
  return { state: path.join(dir ?? home, '.claude.json'), settings: dir ?? path.join(home, '.claude') };
}
const ancestors = (dir: string) => { const dirs: string[] = []; for (let d = path.resolve(dir); ; d = path.dirname(d)) { dirs.push(d); if (path.dirname(d) === d) return dirs; } };
const samePath = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function checkServer(name: string, c: unknown): asserts c is McpServer {
  if (!isMap(c)) throw new Error(`mcpServers.${name} must be an MCP server config`);
  const type = c.type ?? (c.url !== undefined ? 'http' : 'stdio');
  if (!['stdio', 'http', 'sse'].includes(type as string)) throw new Error(`mcpServers.${name}: type must be stdio, http or sse`);
  if (type === 'stdio' ? typeof c.command !== 'string' || !c.command : typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) throw new Error(`mcpServers.${name}: ${type === 'stdio' ? 'a stdio server needs a command' : `an ${type} server needs an http(s) url`}`);
  if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some(arg => typeof arg !== 'string'))) throw new Error(`mcpServers.${name}.args must be a list of strings`);
  for (const key of ['env', 'headers']) if (c[key] !== undefined && !stringMap(c[key])) throw new Error(`mcpServers.${name}.${key} must map names to strings`);
}
/** The call's `mcpServers` as [name, inline config or undefined for a name to look up]; throws on a malformed list. */
export function mcpServerEntries(value: unknown): [string, McpServer | undefined][] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('mcpServers must be a list of at most 20 server names or { name: config } objects');
  if (JSON.stringify(value).length > 65536) throw new Error('mcpServers must be at most 64 KiB of JSON');
  const entries = value.map((entry): [string, McpServer | undefined] => {
    if (typeof entry === 'string') return [entry, undefined];
    const pairs = isMap(entry) ? Object.entries(entry) : [];
    if (pairs.length !== 1) throw new Error('mcpServers: an inline server is { name: config }, one server per entry');
    return pairs[0] as [string, McpServer];
  });
  const seen = new Set<string>();
  for (const [name, config] of entries) {
    if (!SERVER_NAME.test(name)) throw new Error(`mcpServers: ${JSON.stringify(name).slice(0, 80)} is not a server name of letters, digits, hyphens or underscores`);
    if (name.toLowerCase() === 'stampede') throw new Error('mcpServers: stampede is Stampede\'s own server, which the hub adds');
    if (seen.has(name.toLowerCase())) throw new Error(`mcpServers: ${name} is named twice`);
    seen.add(name.toLowerCase());
    if (config !== undefined) checkServer(name, config);
  }
  return entries;
}
/** A named server as Claude Code finds it for `cwd`: local scope (`.claude.json` projects), then the project's `.mcp.json`, then user scope. */
async function claudeServer(name: string, cwd: string, env: NodeJS.ProcessEnv) {
  const state = await readJsonFile(claudeFiles(env).state).catch(() => null);
  const dirs = ancestors(cwd);
  const projects: [string, any][] = isMap(state?.projects) ? Object.entries(state.projects) : [];
  for (const dir of dirs) for (const [key, project] of projects) if (samePath(key, dir) && isMap(project?.mcpServers?.[name])) return project.mcpServers[name];
  for (const dir of dirs) { const file = await readJsonFile(path.join(dir, '.mcp.json')).catch(() => null); if (isMap(file?.mcpServers?.[name])) return file.mcpServers[name]; }
  return isMap(state?.mcpServers?.[name]) ? state.mcpServers[name] : undefined;
}
async function codexServer(name: string, env: NodeJS.ProcessEnv) {
  const file = path.join(env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  const text = await readFile(file, 'utf8').catch(() => '');
  let config: any;
  try { config = text ? parseToml(text) : {}; } catch (error) { throw new Error(`mcpServers: cannot read ${file}: ${(error as Error).message}`); }
  // Plain objects: smol-toml's tables have no prototype, and its dates become strings.
  return isMap(config.mcp_servers?.[name]) ? JSON.parse(JSON.stringify(config.mcp_servers[name])) as McpServer : undefined;
}
/** A server in Claude's shape as Codex's `mcp_servers` table, with `${VAR}` and `${VAR:-default}` expanded from `env` (Claude expands them itself). */
export function toCodex(name: string, c: McpServer, env: NodeJS.ProcessEnv): McpServer {
  checkServer(name, c);
  const type = c.type ?? (c.url !== undefined ? 'http' : 'stdio');
  if (type === 'sse') throw new Error(`mcpServers.${name}: Codex has no SSE transport; use a stdio or streamable http server`);
  const x = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, key: string, fallback?: string) => {
    const found = env[key] ?? fallback;
    if (found === undefined) throw new Error(`mcpServers.${name}: \${${key}} is not set`);
    return found;
  });
  const map = (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, string>).map(([k, v]) => [k, x(v)]));
  return type === 'stdio'
    ? { command: x(c.command as string), ...(c.args ? { args: (c.args as string[]).map(x) } : {}), ...(c.env ? { env: map(c.env) } : {}) }
    : { url: x(c.url as string), ...(c.headers ? { http_headers: map(c.headers) } : {}) };
}
/**
 * Each server the call names, in its backend's shape: inline ones as given
 * (converted for Codex), named ones from that backend's own configuration —
 * Claude Code's MCP scopes for `cwd`, or Codex's config.toml.
 */
export async function resolveMcpServers(value: unknown, backend: 'claude' | 'codex', cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const servers: Record<string, McpServer> = {};
  for (const [name, inline] of mcpServerEntries(value)) {
    if (inline) { servers[name] = backend === 'codex' ? toCodex(name, inline, env) : inline; continue; }
    const found = backend === 'codex' ? await codexServer(name, env) : await claudeServer(name, cwd, env);
    if (!found) throw new Error(backend === 'codex'
      ? `mcpServers: no MCP server named ${name} in your Codex config.toml; pass it inline as { ${name}: { command, args } }`
      : `mcpServers: no MCP server named ${name} in your Claude Code config for ${cwd} (local scope, .mcp.json or user scope); servers from plugins or claude.ai connectors are not found by name, so pass it inline as { ${name}: { command, args } }`);
    servers[name] = found;
  }
  return servers;
}
/** The call's `plugins` checked: plugin ids, bare names or `*`, each turned on or off. */
export function checkPlugins(value: unknown): asserts value is Record<string, boolean> {
  if (!isMap(value) || Object.keys(value).length > 50) throw new Error('plugins must map at most 50 plugin ids (name@marketplace), names or * to true or false');
  for (const [id, on] of Object.entries(value)) {
    if (id !== '*' && !PLUGIN_ID.test(id) || typeof on !== 'boolean') throw new Error('plugins must map at most 50 plugin ids (name@marketplace), names or * to true or false');
    if (on && (id === 'stampede' || id === STAMPEDE_PLUGIN)) throw new Error('plugins: workers never load Stampede\'s own plugin');
  }
}
/**
 * The worker's `enabledPlugins`, which Claude merges over the user's by id:
 * `*` sets every plugin installed or named in the user, project and local
 * settings, a bare name each id of that name, a full id itself; Stampede's
 * own plugin is always off. Built-in plugins (`name@builtin`) are only set by id.
 */
export async function resolvePlugins(choice: Record<string, boolean>, cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const { settings } = claudeFiles(env);
  const files = [path.join(settings, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
  const known = new Set<string>();
  for (const file of files) { const parsed = await readJsonFile(file).catch(() => null); if (isMap(parsed?.enabledPlugins)) for (const id of Object.keys(parsed.enabledPlugins)) known.add(id); }
  const installed = await readJsonFile(path.join(settings, 'plugins', 'installed_plugins.json')).catch(() => null);
  if (isMap(installed?.plugins)) for (const id of Object.keys(installed.plugins)) known.add(id);
  const enabled: Record<string, boolean> = {};
  if (choice['*'] !== undefined) for (const id of known) enabled[id] = choice['*'];
  for (const [id, on] of Object.entries(choice)) {
    if (id === '*') continue;
    if (id.includes('@')) { enabled[id] = on; continue; }
    const ids = [...known].filter(known => known.split('@')[0] === id);
    if (!ids.length) throw new Error(`plugins: no installed plugin named ${id}; give its full id (name@marketplace) as claude plugin list shows it`);
    for (const match of ids) enabled[match] = on;
  }
  return { ...enabled, [STAMPEDE_PLUGIN]: false };
}
