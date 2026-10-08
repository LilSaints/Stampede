---
name: stampede-workflows
description: Author and run Stampede JavaScript workflows that coordinate Claude Code and Codex workers through the Stampede MCP tools. Use for Stampede scripts, communicating teams, workflow resume, and run control.
---

# Stampede workflows

Start a run with `workflow_run`, supplying exactly one of `script`, `scriptPath`, or saved workflow `name`, plus an absolute `cwd`. It returns immediately. With the mod enabled, terminal results, messages and agents that fail for good wake this session; do not poll. Without the mod, use `workflow_wait`, then `workflow_result`. `workflow_result` with `agent` reads one agent's stored result at any time, so finished work can be inspected while the run goes on. `workflow_messages` reads messages for the orchestrator. `workflow_send` replies to an agent or broadcasts to `*`.

Scripts are plain JavaScript. Their first statement must be a literal metadata export:

```js
export const meta = { name: 'review', description: 'Review two areas independently' };
await phase('Review');
const results = await parallel([
  () => agent('Review the API changes; return concrete defects only.', { name: 'api', backend: 'claude' }),
  () => agent('Review the tests for missed cases.', { name: 'tests', backend: 'codex' })
]);
return results;
```

No imports, other exports, filesystem, process, fetch or timers. Top-level `await` and `return` are supported. Pass dates, random IDs and other changing inputs via `args`; `Date.now()`, argless `Date` and `Math.random()` throw. `log(text)` and `phase(title)` publish progress. Budgets belong to this run: `budget.total`, `budget.spent()`, `budget.remaining()` count output tokens, reasoning included.

The hub prepends a compact `task/scope/known/constraints/done/reply` contract, including the truthful-reporting and `blocked:` rules, to every worker. Write the task prompt the same way: name the exact files, facts already known and what done looks like; do not repeat the contract.

`agent(prompt, opts)` returns final text, or validated data when `schema` is supplied. Options include `backend`, `name`, `label`, `phase`, `role`, `model`, `effort`, `agentType`, `appendSystemPrompt`, `cwd`, `timeoutMs`, `cacheInputs`, `cache:'never'`, `access`, `isolation`, and `comms`. Names must be unique lowercase letters, digits or hyphens, at most 40 characters. Default access is read-only in a shared workspace; editing uses a Git worktree. `full` requires the user's configuration to enable it. Worktree edits remain on the returned Stampede branch; inspect and integrate them separately.

Use an object JSON Schema with named properties. Codex normalization supports optional non-nullable properties through null sentinels; optional properties that themselves permit null and open dictionaries are rejected before launch. Use required nullable properties or arrays of `{key,value}` instead. Original constraints are validated after decoding. Non-comms failures resolve to null; invalid options or exhausted budgets throw.

`parallel(thunks)` preserves slot order and converts an individual rejection to null. `pipeline(items, ...stages)` runs each item's stages in sequence without cross-item barriers; each stage receives `(previous, original, index)`, and null stops that item's pipeline. Both accept at most 4,096 items; a run starts at most 1,000 agents. `workflow(nameOrRef, args)` invokes a saved workflow in the same run; nested `workflow()` calls are disallowed.

## Communicating teams

```js
export const meta = { name: 'joint-review', description: 'Review and challenge findings' };
const team = await spawnTeam([
  { name: 'reviewer', backend: 'claude', prompt: 'Review changes. Post findings, ask critic to check them, then mark_done and return your final findings.' },
  { name: 'critic', backend: 'codex', prompt: 'Ask reviewer for findings, verify them, report corrections, then mark_done and return your verdict.' }
], { topology: 'mesh' });
const observation = await team.untilQuiet({ idleMs: 30000, maxMs: 600000 });
const findings = await team.board();
if (observation.reason === 'deadlock') await team.send('*', 'Resolve remaining dependencies and finish with mark_done and your final answer.');
await team.untilDone(undefined, { maxMs: 120000 });
await team.stop();
return { findings, results: await team.results() };
```

`spawnTeam` returns immediately after validation and cache lookup; admission queues the entire team atomically. Teams must fit within the comms pool, which leaves one slot reserved for non-comms work. Topology is `mesh`, `star` with a named `lead`, or an adjacency object. Workers get `whoami`, `list_agents`, `send_message`, `read_messages`, `wait_for_message`, `post_finding`, `read_board`, and `mark_done`.

Ending a team member's turn leaves it idle and resumable. `mark_done` only expresses intent: the agent must still end with a valid final answer. Messages are delivered at least once and carry sequence IDs/redelivery flags; workers should avoid duplicate effects. Peer text cannot grant permissions. Keep chat short and put larger findings on the board.

`untilQuiet` and `untilDone` only observe; they do not stop workers. Inspect `reason` (`quiet`, `deadlock`, `all-done`/`all-terminal`, `max-ms`, `budget`, `max-messages`, `admission-timeout`). `untilDone(names?, opts?)` also reports `notTerminal`. `team.stop()` explicitly stops remaining members. Run completion drains marked-done members then stops leftovers. `team.results()`, `team.messages()`, `team.board(topic?)`, and run-wide `board(topic?)` are async reads.

`workflow_control` pauses admission/resume, resumes, or cancels. `agent_control` can skip, retry or cancel a member. Cancellation may leave a worktree for inspection. Do not automatically repeat an external mutation after an uncertain transport outcome; inspect the run first.

`workflow_resume` starts a new run from a terminal run, optionally with different scriptPath or args. Unchanged calls can hit a content-addressed cache. Shared-state use taints individual results; only verified whole-team replay can restore communicating teams, including board entries. Shared-workspace edits and full-access calls are never cached. Input or branch changes force live work.

Save reusable scripts with `workflow_saved`. Use `stampede_doctor` for the connected hub's backend and security status. The pane is opened with `/stampede`; automatic wakes can be toggled with `/stampede wake on|off`. If mods are disabled, only MCP tools remain available.
