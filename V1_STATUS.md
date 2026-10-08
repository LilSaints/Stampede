# V1 implementation status

Goal: finish SPEC.md M0–M5. This is an implementation checkpoint, not a release declaration. M6 live steering and preemption are excluded.

## Implemented and exercised

- Private GitHub repository initialized at LilSaints/Stampede; initial specification and spike sources pushed.
- Strict TypeScript runtime, parser, worker watchdog, deterministic hooks, parallel and pipeline execution.
- Local authenticated hub, MCP shims, process adapters, Windows state ACL and ancestry helper.
- Scheduler reservations, gang admission, non-comms reserve, bounded admission failures.
- Durable message claims, transport handoff acknowledgements, abnormal-turn redelivery, board.
- Run lifecycle, budgets, agent controls, worktrees, input fingerprints, individual cache and whole-team replay.
- Interrupted-run recovery revokes credentials and checks process creation identity before terminating an orphan.
- Setup, doctor, retention and worktree garbage collection commands; hub restart endpoint.
- Claude mod pane, actions, owner-specific wakes, debounce/rate cap and busy suppression.

Last full core suite: 25 tests passed. Last mod suite: 11 tests passed. Strict plugin validation and both TypeScript projects passed before the latest edits; repeat relevant checks before release.

## Measured real-backend results

- Claude 2.1.292: settings hook fired, inherited the synthetic environment nonce, and injected context; a 45-second MCP wait completed.
- Codex 0.159.2: per-call MCP and developer instructions worked. Per-call hooks were not observed, including trusted-hook and corrected-regex probes. The polling/resume fallback remains selected.
- Codex shared home: eight simultaneous conversations over three waves (24 turns), including two resume waves, passed with correct thread IDs and remembered nonces; no database-corruption signatures were observed.
- Earlier S20–S23 ancestry/sandbox evidence is recorded in spikes/RESULTS.md.
- Real Claude-to-Codex pipeline and a mixed team using actual MCP worker shims passed. Claude read-only coordination required default permission mode with explicit allow/deny rules; plan mode prevented truthful mutating coordination tools.
- Hook startup: 30 Windows launches, 118.04 ms p95 (hub round trip excluded).

## Still required before claiming V1 complete

- Finish and record the remaining applicable M0 capability probes. Capability results must invalidate on backend version changes.
- Qualify actual plugin transport, tool interception and wakes in interactive Claude; manual desktop surface checks cannot be replaced by the test renderer.
- Finish UI action/transport/wake integration tests and event-gap reconciliation checks. The bounded view, recipient Select/Send, numeric tab hotkeys and snapshot notification recovery are implemented.
- Finish lifecycle audit and race tests. Retry slot release, idle reservation release, per-agent metadata, lifecycle events and log rotation are implemented.
- Broaden end-to-end parity coverage to both actual backends, messaging transports, crash/timeout/auth/schema failures and mixed-backend workflows.
- Complete doctor sandbox readiness and plugin connectivity reporting; verify init/restart/gc behavior.
- Verify the installation documentation and bundled workflow authoring skill against the final behavior.
- Review changes, run release checks, commit and publish the implementation. Raw probe artifacts, local Claude settings and generated CLI declarations stay excluded.

Raw evidence is local under ignored `spikes/artifacts/`. Do not treat an unperformed probe as passing.
