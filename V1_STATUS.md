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

- 30 core tests pass. Bus delivery testing covers 1,000 seeded schedules with 600 worker deliveries each. Integration covers admission timeout, idle release, pending-message retention at resume limits, auth fast-failure, timeout retry, budget limits, delayed final output after mark_done, run-end drain, cache replay, and orphan recovery.
- Both config-selected fake CLI adapters pass schema pipelines, judge panels with a failed slot, and bounded loops. Four mixed workers use the actual MCP stdio shim for 600 ordered, committed deliveries; mutual waiting reports deadlock while a non-comms call makes progress, and an idle two-message burst produces one resume. A stopped queued team leaves no scheduler entry. Shutdown joins worker tasks and final persistence before returning.
- Cache integration verifies identical-call hits, exactly one live call after a single prompt edit, reviewed-file and explicit-input invalidation, kept-worktree branch verification, shared-edit exclusion, and read-board taint. Team board replay remains covered by the hub integration test.
- 19 plugin tests pass, including terminal/desktop render fixtures at body widths 38/40/60/100/160, retained agent controls, draft preservation during Pause, mutating pane actions, actual plugin tool-prefix interception, polling/wake behavior and a bounded 1,000-agent pane.
- Core and installed-host mod TypeScript checks pass. Strict plugin validation passes.
- Real Claude-to-Codex schema pipeline and mixed-backend coordination team pass.
- Eight concurrent Codex conversations over three waves (24 turns) pass with shared home and correct resume identity.
- Actual terminal plugin sessions record ownership, submit one attributed completion wake, retrieve result 42, advance the seen cursor and render `/stampede`. A zero-model-call host probe also passed outside-project state access, hot-reload timer re-registration, hub restart reconnection and the version-mismatch banner.
- Doctor verifies the exact state ACL, workspace-write readiness and denial of a synthetic protected-state read. Init, duplicate-hub handling, refused active restart, forced restart recovery and retention passed the maintenance probe.

See [spikes/RESULTS.md](spikes/RESULTS.md) for the capability matrix, selected fallbacks and local evidence paths. Raw artifacts, credentials, CLI session output, generated declarations and local Claude settings remain ignored.

- Self-contained release bundles install in an isolated Claude configuration with no `node_modules`; the installed MCP connects and a bundled workflow returns 42. Generated disable settings remove the installed orchestrator MCP from workers. No credentials were copied.
- Dedicated hook startup: 30 launches, p95 149.56 ms. The bundled full-CLI path missed the target, so workers use `dist/hook.js`. Its real claim/print/ack transport passes integration testing.

- GitHub Actions now runs Node 22 core tests on Windows and Ubuntu. Both jobs passed for commit `c5e969a`: [CI run](https://github.com/LilSaints/Stampede/actions/runs/37741506755).
- Live terminal checks at 40/100/160 columns used a real hub and fake workers with no model calls. Controls exercised across those widths: Pause/Resume, Enter-send and Send button, recipient Select, Retry, Skip, copy-path OSC52, Cancel/No/Yes, composer Close and Escape. Mutation responses appeared within the 270 ms tool observation window. This exposed and fixed hidden agent controls in the actual 38-column body of a 40-column terminal. Evidence is in `spikes/artifacts/ui-widths-20261008/manual-summary.json`.

## Remaining release gates

1. Complete the live Claude desktop Code-tab checklist: transport, pane/input/select/action behavior, attributed wake, restart recovery and mismatch banner. Available computer-control tools cannot operate this surface; user verification has been requested. Terminal controls were exercised across the required widths, but not every action was repeated at every width.
2. Finish the requirement-level integration audit in SPEC §24. The 1,000-schedule test directly exercises the bus; the four-process mixed-backend test now uses the real MCP shim but has not run 1,000 seeded process schedules. The required shim/hook delivery-fault suite and ACL tamper/repair scenarios still need explicit coverage. The fake parity scenarios now cover pipelines, panels and loops, but need comparison with the exact built-in reference examples. Earlier broad “implemented” summaries must not be treated as proof of these acceptance gates.
3. Review the remaining actual-backend E2E evidence against the exact §24/§25 scenarios (peer exchange, message-driven resume, parity examples and parallel batch), without treating the already-passing pipeline/team smoke tests as coverage of every scenario.
4. After acceptance, create a versioned release with `dist/cli.js`, `dist/worker.js`, `dist/hook.js` and `dist/windows-helper.ps1` committed as required by the spec. Development checkouts build with `npm ci` and `npm run build`.

The code is reviewable and the automated checks pass. These outstanding gates prevent declaring the original “Finish V1” goal complete.
