import { randomUUID } from 'node:crypto';
import type { AgentLaunch } from './adapter.js';
export function claudeArgv(a: AgentLaunch, resumeSessionId?: string) {
  const argv = [...(a.entry ? [a.entry] : []), '-p', '--output-format', 'stream-json', '--verbose', resumeSessionId ? '--resume' : '--session-id', resumeSessionId ?? randomUUID(), '--append-system-prompt', a.contract, '--mcp-config', a.mcpPath, '--settings', a.settingsPath];
  if (!a.inheritMcpServers) argv.push('--strict-mcp-config');
  if (!a.comms && a.persistNonComms === false) argv.push('--no-session-persistence');
  if (a.settingSources !== undefined) argv.push('--setting-sources', a.settingSources);
  if (a.model) argv.push('--model', a.model);
  if (a.effort) argv.push('--effort', a.effort);
  if (a.agentsPath) argv.push('--agents', a.agentsPath);
  if (a.agentType) argv.push('--agent', a.agentType);
  // Every skill and custom command is listed in the prompt of each API call.
  if (a.skills === false) argv.push('--disable-slash-commands');
  if (a.maxUsd !== undefined) argv.push('--max-budget-usd', String(a.maxUsd));
  if (a.schema) { const json = JSON.stringify(a.schema); if (json.length > 24000) throw new Error('schema too large for Claude argv'); argv.push('--json-schema', json); }
  // One comma-separated value: the flag takes a variable number of them. MCP tools are not built-in, so it keeps them.
  if (a.tools) argv.push('--tools', a.tools.join(','));
  const servers = Object.keys(a.mcpServers ?? {});
  const tools = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', ...(a.comms ? ['mcp__stampede__*'] : (a.mcpTools ?? []).map(tool => `mcp__stampede__${tool}`)), ...servers.map(name => `mcp__${name}__*`)];
  // Removing recursion tools also protects against instructions in project files.
  // Other denials only shorten the prompt that every API call re-reads.
  const denied = ['Agent', 'Task', 'TeamCreate', 'TeamDelete', 'Workflow', ...(a.denyTools ?? [])];
  if (a.access === 'full') argv.push('--dangerously-skip-permissions');
  else {
    // Plan-mode system instructions forbid even truthfully annotated Stampede
    // messaging writes, and the actions of the MCP servers a call asks for.
    // Explicit tool grants plus edit/shell denials preserve filesystem
    // read-only access while allowing coordination.
    if (a.access === 'read-only') { argv.push('--permission-mode', a.comms || servers.length ? 'default' : 'plan'); denied.push('Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'); }
    else { argv.push('--permission-mode', 'acceptEdits', ...(a.writableDirs?.length ? ['--add-dir', ...a.writableDirs] : [])); tools.push('Edit', 'Write', 'NotebookEdit', ...(a.editShellAllow ?? [])); if (!a.editShellAllow?.length) denied.push('Bash', 'PowerShell'); }
    argv.push('--allowedTools', ...tools);
  }
  argv.push('--disallowedTools', ...denied);
  return argv;
}
