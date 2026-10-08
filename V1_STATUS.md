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

- All 48 core tests pass in the normal local npm test build and Windows CI at e947a7b; Ubuntu passes 46 applicable tests, skipping the two Windows-only checks. Bus delivery testing covers 1,000 seeded schedules with 600 worker deliveries each. Integration covers admission timeout, idle release, pending-message retention at resume limits, auth fast-failure, timeout retry, budget limits, delayed final output after mark_done, run-end drain, cache replay, and orphan recovery.
- Both config-selected fake CLI adapters pass schema pipelines, judge panels with a failed slot, and bounded loops. Four mixed workers use the actual MCP stdio shim for 600 ordered, committed deliveries; mutual waiting reports deadlock while a non-comms call makes progress, and an idle two-message burst produces one resume. A stopped queued team leaves no scheduler entry. Shutdown joins worker tasks and final persistence before returning.
- The actual installed Claude Code 2.1.292 Workflow reference was inspected without model calls. Its review-changes and loop-until-dry examples, plus the documented judge-panel pattern, now pass on both fake backends with deterministic prompt/schema fixtures. Assertions cover confirmed findings, rejected-finding deduplication, two dry rounds, majority voting, agent counts, phase ordering, winner selection and synthesis inputs.
- Cache integration verifies identical-call hits, exactly one live call after a single prompt edit, reviewed-file and explicit-input invalidation, kept-worktree branch verification, shared-edit exclusion, and read-board taint. Team board replay remains covered by the hub integration test.
- Fingerprints are memoized for the configured TTL within a run, invalidated across active runs when a writer ends a turn, and recomputed on resume. Queued teams refresh their keys after admission. Call journals record shared reads/writes and external web/MCP tool names; cache results report those external dependencies without copying tool arguments or results.
- A controlled delayed-persistence regression verifies that terminal team observation and run completion wait for idle-agent finalization and reservation release. Windows and Ubuntu CI both pass for this fix at `6f2a889`.
- USD admission checks the effective model, including agent-type defaults and explicit overrides. Explicit agent phases are registered for pane visibility. Child workflows use scoped `▸ name / phase` groups, share up-to-date token counters, reject further nesting, and cancel with their parent; child workers are also stopped when the parent finishes.
- Delivery fault integration drops actual hub-to-shim HTTP responses, kills the shim after stdout, kills hooks before/after stdout, and kills the actual worker after handed delivery. Each scenario replays the ordered three-message suffix with redelivery flags and commits only after a normal retry turn.
- Windows ACL integration starts with inheritable Everyone access and a protected descendant with explicit grants, verifies the exact owner-only predicate after hub startup, tampers with a child file and verifies repair on restart. It includes CodexSandboxUsers when that local group exists. Doctor fails on a state junction that cannot be safely repaired.
- The live crash regression kills a separate hub while both mixed-backend workers are running, restarts from its durable state, verifies interrupted status and no surviving workers, then resumes with one cached completed call and a freshly executed two-member team. This Windows host terminates both workers with the killed hub; Ubuntu CI leaves both workers alive after the kill, then verifies that restart removes them. The independent Windows orphan-identity recovery test also passes.
- Windows acceptance checks cover 100 KB UTF-8 stdin through both adapters with paths containing spaces, worker-plus-descendant cancellation, and simulated EBUSY rename retries including exhaustion without losing the previous snapshot. Eight concurrent fake workers edit isolated worktrees; snapshot commits, preserved edits and unchanged-worktree cleanup pass.
- Status/wait previews now select the latest five orchestrator-inbox messages independently of peer chatter. Queued comms teams report reservation holders and their states; undeliverable delivery counts survive run completion. A real local HTTP regression also checks that an observer reading messages leaves the owner cursor unread.
- The mixed-process harness accepts `STAMPEDE_CONCURRENCY_SEEDS=1000`, seeds worker send/read delays, checks quiescence throughout each burst, and removes each completed fixture's logs. The full 1,000-schedule qualification passed (600,000 worker deliveries); evidence is spikes/artifacts/mixed-process-1000-20261008.log. Hub close now joins HTTP handlers, maintenance and event persistence, and rejects new runs while shutting down.
- 22 plugin tests pass, including terminal/desktop render fixtures at body widths 38/40/60/100/160, retained agent controls, draft preservation during Pause, mutating pane actions, actual plugin tool-prefix interception, polling/wake behavior and a bounded 1,000-agent pane.
- The band now includes running/waiting counts and completed-run unread messages. Pane headings include run ID, elapsed time and budget total; phases show state counts and rows show activity. Authentication alerts can be dismissed, compactBand is honored, and toasts coalesce during the rate window, including one wake-limit warning. The 1,000-agent pane stays below 20,000 characters with or without a full message draft.
- Core and installed-host mod TypeScript checks pass. After the long qualification, the normal bundles were rebuilt and all 48 core tests passed in 55.7 seconds; all 22 plugin tests and strict validation passed again.
- Real Claude-to-Codex schema pipeline and mixed-backend coordination team pass.
- Eight concurrent Codex conversations over three waves (24 turns) pass with shared home and correct resume identity.
- Actual terminal plugin sessions record ownership, submit one attributed completion wake, retrieve result 42, advance the seen cursor and render `/stampede`. A zero-model-call host probe also passed outside-project state access, hot-reload timer re-registration, hub restart reconnection and the version-mismatch banner.
- Doctor verifies the exact state ACL, workspace-write readiness and denial of a synthetic protected-state read. Init, duplicate-hub handling, refused active restart, forced restart recovery and retention passed the maintenance probe.

See [spikes/RESULTS.md](spikes/RESULTS.md) for the capability matrix, selected fallbacks and local evidence paths. Raw artifacts, credentials, CLI session output, generated declarations and local Claude settings remain ignored.

- Self-contained release bundles install in an isolated Claude configuration with no `node_modules`; the installed MCP connects and a bundled workflow returns 42. Generated disable settings remove the installed orchestrator MCP from workers. No credentials were copied.
- Dedicated hook startup: 30 launches, p95 149.56 ms. The bundled full-CLI path missed the target, so workers use `dist/hook.js`. Its real claim/print/ack transport passes integration testing.

- GitHub Actions runs Node 22 core tests on Windows and Ubuntu. Both jobs passed for commit `e947a7b`: [CI run](https://github.com/LilSaints/Stampede/actions/runs/37763740426).
- Live terminal checks at 40/100/160 columns used a real hub and fake workers with no model calls. Controls exercised across those widths: Pause/Resume, Enter-send and Send button, recipient Select, Retry, Skip, copy-path OSC52, Cancel/No/Yes, composer Close and Escape. Mutation responses appeared within the 270 ms tool observation window. This exposed and fixed hidden agent controls in the actual 38-column body of a 40-column terminal. The earlier cross-width evidence is in `spikes/artifacts/ui-widths-20261008/manual-summary.json`. The complete worker-control matrix was subsequently repeated independently at each width; evidence is in `spikes/artifacts/ui-matrix-{40,100,160}-20261008/manual-summary.json`. The 160-column run used the right sidebar. Every fixture was cancelled and shut down, with zero model calls. This exposed and fixed elapsed time briefly resetting during actions; the pane now reads the host clock independently of poll invalidation.

- Additional acceptance evidence: the 30-second mark_done regression passes with four mixed fake workers, covering direct agent(), untilDone, early script return and durable final-output drain. Run tabs now stack below 60 body columns and wrap above; manual pane opens request keyboard focus while automatic opens do not. Band controls and hotkeys passed at 40/100/160 columns with zero model calls (spikes/artifacts/ui-band-40-20261008/manual-summary.json). All 22 plugin tests, mod type checking and strict validation pass. CI at 93ab048 passed on Windows and Ubuntu.

- Configuration loading now clamps per-run concurrency to the Workflow CPU/16-agent ceiling, even if home settings raise other pools. The regression verifies the ceiling, retained lower limits, rejected project increases and reserves that no longer fit. It passes locally.

- Backend cooldown now applies to the final rate-limit/overload failure even when retries are exhausted. The real adapter with a fake worker records all six failures/cooldowns and the five expected jittered backoffs; only retry waits are accelerated. Scheduler checks verify held permits survive cooldown and queued capacity recovers after 60 seconds, then every 30 seconds.

- Team admission now validates messaging qualification, member names/workspace paths and topology before creating members. A reproduced partial-roster failure is fixed: five invalid-team cases leave no counters, roster entries or reservations, then the same names work. An explicit topology map also supports the valid name constructor without reading inherited properties. The focused integration passes; local coverage is now 47 tests across the earlier full run and added regressions.

- Fresh release-candidate bundles from runtime commit 24afad0 pass isolated installation without node_modules: MCP connects, disabled-plugin settings remove the server, and the packaged workflow returns 42. Zero model calls; the temporary installation was removed. The four files and SHA-256 manifest are in spikes/artifacts/release-candidate-24afad0; package evidence is in spikes/artifacts/s17-current-24afad0/summary.json. The long qualification retains its original dist files.

- Exact admission boundaries pass through the runtime: 4,096 parallel/pipeline entries are accepted, 4,097 reject before any callback RPC; 999 terminal agent records still consume lifetime capacity, a two-member team then rejects without partial admission, the 1,000th member is admitted, and the next agent() throws across the workflow worker boundary. This test uses actual admission records with no worker-process launches. Local coverage totals 48 tests across the verified full run and focused additions.

## Final acceptance pass - 2026-10-08

- Real peer exchange passes with exactly three pings per worker and six committed deliveries; all three Claude deliveries use the mid-turn hook. Message-driven resume passes independently on Claude and Codex with stable session IDs. The six-worker mixed batch passes with all six turns overlapping. Evidence: `spikes/artifacts/v1-acceptance-final/summary.json`.
- All three reference workflows (review-changes, loop-until-dry, judge-panel) now pass on both real backends, totaling 46 worker calls. Fake and real suites share the same control-flow/schema fixtures; the real runner supplies low-effort models and synthetic fixture facts through agent options. Evidence: `spikes/artifacts/v1-reference-final/summary.json`; runner: `spikes/v1-reference.mjs`.
- Manual Wake now passes in actual terminals at 40, 100 and 160 columns. Each session starts with a zero hourly wake limit, displays pending updates, and submits exactly one attributed Stampede prompt when clicked, including the quoted peer message. Each receives the fixture acknowledgement, clears its pending wake control and exits. All fixture runs were cancelled and hubs shut down. Evidence: `spikes/artifacts/ui-wake-{40,100,160}-final/manual-summary.json`.
- The first core run under simultaneous real-backend load exposed a test that treated a timed-out five-second workflow_wait as completion. The test now waits for a terminal response with a bounded overall deadline. All 48 core tests then pass in 62.4 seconds. All 22 plugin tests, strict plugin validation, core/mod TypeScript checks and fresh isolated packaging pass. Evidence: `spikes/artifacts/v1-final-core-recheck.log`, `v1-final-plugin.log`, and `s17-final-current/summary.json`.
- The requirement-level [acceptance audit](V1_ACCEPTANCE.md) maps V1 requirements to evidence and lists the exact remaining desktop checks. Desktop discovery/inspection succeeded, but activation failed twice with `failed to activate captured window`, including after refreshed window selection. The user has been asked to bring Claude to the foreground and open its Code tab. No desktop pass is claimed.

## Remaining release gates

1. Complete the live Claude desktop Code-tab checklist in [V1_ACCEPTANCE.md](V1_ACCEPTANCE.md): transport, pane/input/select/actions, attributed completion and message wakes, restart recovery and mismatch banner. Automated desktop renderer tests do not replace this gate.
2. Apply any fixes found by desktop acceptance, repeat relevant checks, and keep Windows/Ubuntu CI green. Current test/documentation changes have passed locally but have not been pushed to CI.
3. After acceptance, set coupled versions to 1.0.0, rebuild and verify the release package, commit `dist/cli.js`, `dist/worker.js`, `dist/hook.js` and `dist/windows-helper.ps1`, then create the versioned release tag. No stable release tag has been created.

Real-backend and terminal acceptance are now complete. Live desktop acceptance still prevents declaring V1 complete.

Desktop follow-up: the live pane, authenticated HTTP polling and an attributed
interrupted-run wake are now observed on bundled Claude Code 2.1.293. A duplicate
project MCP server failed because root `.mcp.json` used plugin-only variables.
The server is now declared inline in `.claude-plugin/plugin.json`; fresh discovery
shows only the connected plugin MCP. Strict validation and isolated packaging,
including discovery from the plugin workspace, pass. The full desktop checklist
and successful completion/result-fetch path remain pending; see V1_ACCEPTANCE.md.
