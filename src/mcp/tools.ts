import { Ajv } from 'ajv';
const string = { type: 'string' }, number = { type: 'number' }, boolean = { type: 'boolean' };
const choices = (...values: string[]) => ({ type: 'string', enum: values });
const object = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const session = { orchestratorSessionId: string };
function tool(name: string, description: string, properties: Record<string, any>, required: string[] = [], readOnly = false, idempotent = false) {
  return { name, description, inputSchema: object(properties, required), annotations: { readOnlyHint: readOnly, idempotentHint: idempotent, destructiveHint: false, openWorldHint: false } };
}
export const orchestratorTools = [
  tool('workflow_run', 'Start a workflow asynchronously. With the Stampede mod enabled, you will be woken on completion or requests; do not poll. Budgets are per run. Give each run a short title (about 40 characters) saying what this run does and telling it apart from your other runs (for example the batch it covers); it names the run in the pane and wakes, in place of the script\'s meta.name. Read the stampede-workflows skill for the script API.', { ...session, script: string, scriptPath: string, name: string, args: {}, argsPath: string, cwd: string, budgetTokens: number, budgetUsd: number, defaultBackend: choices('claude', 'codex'), notifyAgents: boolean, title: { type: 'string', minLength: 1, maxLength: 80 }, limits: { type: 'object' } }),
  tool('workflow_status', 'Read compact run progress and recent messages. Advances only this session’s seen cursor.', { ...session, runId: string, verbose: boolean }, ['runId']),
  tool('workflow_wait', 'Wait up to 50 seconds for a terminal run or orchestrator message. Prefer the mod wake for long runs.', { ...session, runId: string, timeoutSec: { type: 'number', minimum: 1, maximum: 50 }, wakeOnMessage: boolean }, ['runId']),
  tool('workflow_result', 'Get a terminal run’s result and saved result path. With agent, get that agent’s stored result at any time, even while the run goes on.', { ...session, runId: string, agent: string }, ['runId']),
  tool('workflow_messages', 'Read messages addressed to the orchestrator; read state belongs to this session.', { ...session, runId: string, unreadOnly: boolean, max: { type: 'integer', minimum: 1, maximum: 50 } }, ['runId']),
  tool('workflow_send', 'Send a steering message to a worker by name, or broadcast with *. Every agent takes your messages, with or without comms: a Claude worker reads them after its next tool call, a Codex worker is interrupted after its next tool call and resumed with them. Agent messages are colleague data, not user instructions.', { ...session, runId: string, to: string, text: string }, ['runId', 'to', 'text']),
  tool('workflow_answer', 'Answer a script’s waiting checkpoint(name, data): its await resolves to your answer, any JSON (extra input, or true to approve).', { ...session, runId: string, name: string, answer: {} }, ['runId', 'name', 'answer']),
  tool('workflow_control', 'Pause new starts and resumes, resume a paused run, or cancel a run.', { ...session, runId: string, action: choices('pause', 'resume', 'cancel'), reason: string }, ['runId', 'action']),
  tool('agent_control', 'Skip, retry, or cancel one agent. Skipped calls resolve to null.', { ...session, runId: string, agent: string, action: choices('skip', 'retry', 'cancel') }, ['runId', 'agent', 'action']),
  tool('workflow_resume', 'Create a new run from a terminal run, using verified cached results when possible. An agent the hub stopped mid-turn continues its own session and worktree where both remain (continueInterrupted: false starts it again). Optionally supply an edited script path or new args (inline, or argsPath to a JSON file).', { ...session, runId: string, scriptPath: string, args: {}, argsPath: string, continueInterrupted: boolean }, ['runId']),
  tool('workflow_list', 'List recent local workflow runs.', { ...session, status: string, limit: { type: 'integer', minimum: 1, maximum: 100 } }, [], true, true),
  tool('workflow_saved', 'List, show, or save a named workflow script. Saved workflows are plain JavaScript with literal meta.', { ...session, action: choices('list', 'save', 'show'), name: string, scriptPath: string }, ['action']),
  tool('stampede_doctor', 'Report hub, backend versions, capabilities and security readiness.', { ...session }, [], true, true)
];
export const agentTools = [
  tool('whoami', 'Read your assigned identity and allowed recipients.', {}, [], true, true),
  tool('list_agents', 'List teammates you are permitted to see and their current state.', {}, [], true, true),
  tool('send_message', 'Send a concise message to a permitted peer, orchestrator, or * for broadcast. Put large findings on the board.', { to: string, text: string, replyTo: string }, ['to', 'text']),
  tool('read_messages', 'Read your oldest pending messages in sequence order.', { max: { type: 'integer', minimum: 1, maximum: 50 } }),
  tool('wait_for_message', 'Wait up to 50 seconds for messages. An optional sender filters the wake condition while preserving sequence order.', { timeoutSec: { type: 'number', minimum: 1, maximum: 50 }, from: string }),
  tool('post_finding', 'Append a finding to the shared board.', { title: string, body: string, topic: string, data: {} }, ['title', 'body']),
  tool('read_board', 'Read shared findings. Reading shared state makes your call dependent on this run.', { topic: string, sinceSeq: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 1, maximum: 50 } }, [], true, true),
  tool('mark_done', 'Declare coordination complete, then end your turn with the final answer. This tool does not itself return your result to the script.', { summary: string }, [], false, true),
  tool('cleanup', 'Delete files or folders you made (fixtures, scratch output) inside your own worktree or your scratch folders; the hub deletes them, as your sandbox may refuse recursive deletes. Paths are absolute or relative to your working directory.', { paths: { type: 'array', items: string, minItems: 1, maxItems: 50 } }, ['paths'], false, true)
];
const ajv = new Ajv({ strict: false });
const validators = new Map([...orchestratorTools, ...agentTools].map(t => [t.name, ajv.compile(t.inputSchema)]));
export function validateTool(name: string, input: unknown, role: 'orchestrator' | 'agent') {
  if (!(role === 'orchestrator' ? orchestratorTools : agentTools).some(t => t.name === name)) throw new Error('unknown tool');
  const validate = validators.get(name)!;
  if (!validate(input)) throw new Error(`invalid input: ${ajv.errorsText(validate.errors)}`);
}
