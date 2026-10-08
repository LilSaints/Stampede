# V1 implementation status

2026-10-08. Release candidate `1.0.0-rc.1`: M0–M5 implementation is present; V1 release acceptance is still pending. M6 live steering and Appendix A preemption are excluded. No release tag has been created.

## Implemented

- Strict TypeScript workflow parser/runtime, deterministic hooks, watchdog, parallel/pipeline execution and limits.
- Local authenticated hub, role-scoped MCP shims, Claude/Codex process adapters, exact Windows state ACL and process ancestry helper.
- Gang admission, persistent comms reservations, non-comms reserve, project/run caps and bounded admission failures.
- Durable message claims and transport acknowledgements, abnormal-turn redelivery, board, idle resume and once-only limit notifications.
- Agent controls, budgets, schema repair, worktrees, input fingerprints, individual caching and verified whole-team replay.
- Interrupted-run recovery with process creation identity checks; configuration initialization, doctor, retention, worktree collection and restart controls.
- Claude pane, actions, session ownership, seen cursors, event-gap recovery, completion wakes, debounce/rate limit and busy suppression.
- Installation documentation and bundled workflow authoring skill.

## Verification completed

- 27 core tests pass. Delivery testing covers 1,000 seeded schedules with 600 worker deliveries each. Integration covers admission timeout, idle release, pending-message retention at resume limits, auth fast-failure, timeout retry, budget limits, delayed final output after mark_done, run-end drain, cache replay, and orphan recovery.
- 15 plugin tests pass, including terminal/desktop render fixtures at widths 40/100/160, mutating pane actions, actual plugin tool-prefix interception, polling/wake behavior and a bounded 1,000-agent pane.
- Core and installed-host mod TypeScript checks pass. Strict plugin validation passes.
- Real Claude-to-Codex schema pipeline and mixed-backend coordination team pass.
- Eight concurrent Codex conversations over three waves (24 turns) pass with shared home and correct resume identity.
- Actual terminal plugin sessions record ownership, submit one attributed completion wake, retrieve result 42, advance the seen cursor and render `/stampede`. A zero-model-call host probe also passed outside-project state access, hot-reload timer re-registration, hub restart reconnection and the version-mismatch banner.
- Doctor verifies the exact state ACL, workspace-write readiness and denial of a synthetic protected-state read. Init, duplicate-hub handling, refused active restart, forced restart recovery and retention passed the maintenance probe.

See [spikes/RESULTS.md](spikes/RESULTS.md) for the capability matrix, selected fallbacks and local evidence paths. Raw artifacts, credentials, CLI session output, generated declarations and local Claude settings remain ignored.

- Self-contained release bundles install in an isolated Claude configuration with no `node_modules`; the installed MCP connects and a bundled workflow returns 42. Generated disable settings remove the installed orchestrator MCP from workers. No credentials were copied.
- Dedicated hook startup: 30 launches, p95 149.56 ms. The bundled full-CLI path missed the target, so workers use `dist/hook.js`. Its real claim/print/ack transport passes integration testing.

## Remaining release gates

1. Complete the live host checklist: Claude desktop Code tab transport, pane/input/select/action behavior, attributed wake, restart recovery and mismatch banner; live terminal layouts and every action at 40/100/160. Renderer fixtures cover these sizes and actions, but do not establish actual host painting. Available computer-control tools cannot operate the desktop Code tab; user verification has been requested.
2. Review acceptance evidence, then create a versioned release with `dist/cli.js`, `dist/worker.js`, `dist/hook.js` and `dist/windows-helper.ps1` committed as required by the spec. Development checkouts build with `npm ci` and `npm run build`.

The code is reviewable and the automated checks pass. These outstanding gates prevent declaring the original “Finish V1” goal complete.
