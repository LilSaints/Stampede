import type { AgentLaunch } from './adapter.js';
const quote = JSON.stringify;
const bare = (key: string) => /^[A-Za-z0-9_-]+$/.test(key) ? key : quote(key);
/** A config value as TOML for `-c`: JSON's string escapes are TOML's, tables go inline. */
const toml = (value: unknown): string => Array.isArray(value) ? `[${value.map(toml).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).map(([k, v]) => `${bare(k)}=${toml(v)}`).join(',')}}` : typeof value === 'string' ? quote(value) : String(value);
export function codexArgv(a: AgentLaunch, options: { resumeThreadId?: string; platform?: string } = {}) {
  const argv = [...(a.entry ? [a.entry] : []), 'exec', '--json', '--ignore-user-config'];
  if ((options.platform ?? process.platform) === 'win32') argv.push('-c', `windows.sandbox=${quote(a.windowsSandbox)}`);
  argv.push('--skip-git-repo-check', '-C', a.cwd, '-s', { 'read-only': 'read-only', edit: 'workspace-write', full: 'danger-full-access' }[a.access], '-c', 'approval_policy="never"');
  if (a.access === 'edit' && a.writableDirs?.length) argv.push('-c', `sandbox_workspace_write.writable_roots=${quote(a.writableDirs)}`);
  if (a.model) argv.push('-m', a.model);
  // The user's own setting is ignored with their config, so it is passed on when configured.
  if (a.approvalsReviewer) argv.push('-c', `approvals_reviewer=${quote(a.approvalsReviewer)}`);
  if (a.effort) argv.push('-c', `model_reasoning_effort=${quote(a.effort)}`);
  argv.push('--disable', 'multi_agent', '--disable', 'multi_agent_v2');
  if (a.developerInstructionsFlag !== false) argv.push('-c', `developer_instructions=${quote(a.contract)}`);
  if (a.disableHooks) argv.push('--disable', 'hooks');
  if (a.codexHookCommand) {
    argv.push('--enable', 'hooks', '-c', `hooks.PostToolUse=[{matcher=".*",hooks=[{type="command",command=${quote(a.codexHookCommand)},timeout=5}]}]`);
    if (a.trustCodexHooks) argv.push('--dangerously-bypass-hook-trust');
  }
  if (a.schemaPath) argv.push('--output-schema', a.schemaPath);
  if (a.lastMessagePath) argv.push('-o', a.lastMessagePath);
  if (a.comms || a.mcpTools?.length) argv.push(
    '-c', `mcp_servers.stampede.command=${quote(process.execPath)}`,
    '-c', `mcp_servers.stampede.args=${quote([a.cliEntry, 'mcp', '--role', 'agent'])}`,
    '-c', `mcp_servers.stampede.env={${Object.entries({ ...a.mcpEnv, STAMPEDE_HUB_URL: a.hubUrl, STAMPEDE_AGENT_TOKEN: a.token, ...(a.mcpTools ? { STAMPEDE_AGENT_TOOLS: a.mcpTools.join(',') } : {}) }).map(([k, v]) => `${quote(k)}=${quote(v)}`).join(',')}}`,
    '-c', 'mcp_servers.stampede.tool_timeout_sec=120', '-c', 'mcp_servers.stampede.default_tools_approval_mode="approve"'
  );
  // The call's other servers, field by field; with approval_policy="never" a tool needing approval is refused (V-16).
  for (const [name, server] of Object.entries(a.mcpServers ?? {})) {
    for (const [key, value] of Object.entries(server)) if (key !== 'default_tools_approval_mode') argv.push('-c', `mcp_servers.${name}.${bare(key)}=${toml(value)}`);
    argv.push('-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`);
  }
  if (options.resumeThreadId) argv.push('resume', options.resumeThreadId);
  argv.push('-');
  return argv;
}
