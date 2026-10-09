---
name: stampede-workflows
description: Author and run Stampede JavaScript workflows that coordinate Claude Code and Codex workers through the Stampede MCP tools. Use for Stampede scripts, communicating teams, workflow resume, and run control.
---

# Stampede workflows

Start a run with `workflow_run`, supplying exactly one of `script`, `scriptPath`, or saved workflow `name`, plus an absolute `cwd`. Give every run a short `title` (about 40 characters; at most 80) that says what this run does and tells it apart from your other runs, such as `B2: history, editors, storage`; it names the run in the pane and in wakes, where several runs of one script would otherwise share its `meta.name`. Keep agent names (about 20 characters) and phase titles short too: they label the pane's rows, and long ones wrap onto extra lines in a narrow pane. It returns immediately. With the mod enabled, terminal results, messages and agents that fail for good wake this session; do not poll. Without the mod, use `workflow_wait`, then `workflow_result`. `workflow_result` with `agent` reads one agent's stored result at any time, so finished work can be inspected while the run goes on. To also be woken as agents finish, start the run with `notifyAgents: true`, or pass `notify: true` to the `agent()` calls that matter (`notify: false` opts one out); each wake names the agents, not their results. Worktree agents can continue each other's work: `baseRef: { agent: 'b2-integrate' }` (or a git ref) starts an agent's worktree where another's finished, `readWorktrees: ['b2-integrate']` lets a Claude reviewer read that worktree, and `await workspace(name)` gives the script an agent's `branch`, `baseCommit`, `commit` and `path`. With a `schema`, an answer is validated as JSON (from structured output, or from the reply's text) and repaired in the same session before any retry. `workflow_messages` reads messages for the orchestrator. `workflow_send` replies to an agent or broadcasts to `*`.

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

## Cost

Every model call re-reads the caller's whole context, so an agent costs roughly its calls times its context size, and whatever it reads early is paid again on every later call. Cache reads are most of a long worker's bill.

- Your own session counts too. Each wake re-reads its whole context, and after a long idle the whole context is written to the cache again. Once it holds a few hundred thousand tokens, compact it between runs (keep run IDs, decisions and next steps), or hand off to a fresh session. Ask for wakes only for agents you act on mid-run, and read one agent's result (`workflow_result` with `agent`) rather than the whole run's.
- Don't send workers to read what they already have. `agentType` makes that agent file the worker's system prompt, Claude workers load the repository's CLAUDE.md and its imports, and Codex loads AGENTS.md.
- Don't send every worker through the same long docs. Write one short brief per batch (the rules that apply, the spec section, line ranges for the rest) and point the prompts at it.
- Split work only along disjoint files. Each extra worker pays its baseline, the shared reading and any overlapping exploration again, and an integrator then re-reads the combination. Parallel slices on shared files mostly buy wall-clock time.
- Scope re-checks to what changed. A confirming reviewer needs the findings, the fix diff and the fix report, not the full review brief, and usually a lower effort: reasoning is most of a max-effort reviewer's output.
- Tell workers to search, then read line ranges; to keep command output short; and to grep a saved oversized tool result rather than read it whole.
- Claude workers on a 1M-token model rarely reach auto-compaction, so a long task is cheaper as a chain of shorter agents (`baseRef: { agent }`) than as one long run. Codex workers don't draw on Claude usage.

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

`workflow_resume` starts a new run from a terminal run, optionally with different scriptPath or args. Unchanged calls can hit a content-addressed cache. After a hub stop (`interrupted`), an agent cut off mid-turn continues its own session and worktree instead of starting over, where both remain; the run log says which agents continued and which started again (`continueInterrupted: false` starts them all again). Shared-state use taints individual results; only verified whole-team replay can restore communicating teams, including board entries. Shared-workspace edits and full-access calls are never cached. Input or branch changes force live work.

Save reusable scripts with `workflow_saved`. Use `stampede_doctor` for the connected hub's backend and security status. The pane is opened with `/stampede`; automatic wakes can be toggled with `/stampede wake on|off`. If mods are disabled, only MCP tools remain available.
