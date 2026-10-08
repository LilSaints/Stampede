# V1 acceptance audit

Audited 2026-10-08 against SPEC Draft 3.6. Candidate: `1.0.0-rc.1`.
**Release is pending the live Claude desktop Code-tab checklist.** M6 and
Appendix A preemption are outside V1. Renderer fixtures are not desktop evidence.

## Requirement evidence

| Requirement | Result and evidence |
|---|---|
| M0 capability decisions, §12/§22 | Selected fallbacks and version qualifications are recorded in [spikes/RESULTS.md](../spikes/RESULTS.md). Codex uses polling/resume; strict schema normalization is always enabled; Claude schemas are inline; hook startup uses the dedicated bundle. S-25 retains the specified network-unverified fallback. S-14/S-16 desktop observations remain pending. |
| M1 runtime parity, §7 | Fake adapters and real Claude pass review-changes, loop-until-dry and judge-panel. The shared [reference fixtures](../test/fixtures/reference.ts) instantiate reference prompt/schema placeholders; the E2E runner supplies model/effort and synthetic fixture facts through agent options. The same control flow, schemas and expected results run on both backends. This is not a claim that placeholder examples execute verbatim without data. |
| M1 runtime limits, §7.4 | Unit runtime and integration runtime tests cover deterministic APIs, watchdog/cancellation, pipeline behavior, 1,000 lifetime agents and exact 4,096/4,097 collection boundaries. |
| M1 installation and terminal completion wake | Fresh isolated installation connects MCP and returns 42 without node_modules; generated worker settings remove the orchestrator plugin. Earlier live terminal completion retrieves 42 and advances the owner cursor. Desktop completion wake remains pending. |
| M2 Codex parity and mixed pipeline | All three shared reference workflows pass on real Codex. Earlier real Claude→Codex schema pipeline passes. Adapter/schema tests and the recorded S-22/S-23 launch probes cover immutable resume instructions and sandbox/config isolation. |
| M3 real peer coordination, §24 | Real Claude and Codex exchange exactly three pings each. All six deliveries commit; Claude receives three through its mid-turn hook. Each backend independently resumes by message with the same session ID and exactly two turns. Six mixed non-comms turns overlap and return ordered schema results. |
| M3 bus reliability and admission, §10/§14 | The full 1,000 seeded process schedules cover 600,000 deliveries through the real shim. Current transport, bus, scheduler, delivery-fault and hub tests cover suffix redelivery, quiescence/deadlock, gang bypass, idle reservations, admission timeout and release. The long qualification used its frozen runtime; current regressions cover subsequent changes. |
| M3 orchestrator notification | Terminal Wake now includes the quoted peer message and has plugin attribution. Owner/observer cursor isolation and automatic wake coalescing are covered by live terminal evidence and plugin tests. Desktop notification remains pending. |
| M4 completion, recovery and cache, §8/§16 | Completion tests include the 30-second mark_done drain. Crash recovery uses exact process creation identity and verifies cached non-comms results plus fresh team execution. Cache tests cover changed prompts/files/inputs, worktree branch identity, shared edits, read-board taint and team board replay. |
| M4 workspaces, budgets and Windows, §15/§17/§19 | Eight concurrent worktree workers, effective-model USD admission, token limits, 100 KB stdin, kill-tree, EBUSY retry/exhaustion, exact state ACL repair and failed-doctor controls pass. |
| M5 mod and terminal controls, §20 | 22 plugin tests pass on terminal/desktop render fixtures. Earlier live worker-control and band matrices pass at 40/100/160 columns. Manual Wake now additionally passes at each required width, with one attributed prompt per session and no automatic wake under a zero hourly limit. Terminal restart/hot reload/mismatch checks pass. |
| M5 live desktop controls | **Pending.** Computer Use can discover and inspect Claude, but activation returned `failed to activate captured window` twice after refreshing selection. No live desktop transport, painting, controls, wake, restart or mismatch pass is claimed. |
| §21.3 release checks | Current local core: 48/48; plugin: 22/22; strict validation, core and mod TypeScript: pass. The first concurrent-load run exposed a test that mistook a timed-out long poll for completion; the test now polls terminal status within a bounded deadline. Earlier Windows/Ubuntu CI evidence is recorded in V1_STATUS; current local changes have not been pushed to CI. |

## Evidence from this pass

Raw artifacts stay ignored because they can contain session output and local
credentials. These local paths identify the evidence without publishing it:

| Evidence | Path under `spikes/artifacts/` |
|---|---|
| Peer, both resume scenarios, six-worker batch | `v1-acceptance-final/summary.json` |
| Three reference examples × two real backends, 46 worker calls | `v1-reference-final/summary.json` |
| Full core test run, 48 passes in 62.4 seconds | `v1-final-core-recheck.log` |
| Plugin test run, 22 passes | `v1-final-plugin.log` |
| Fresh isolated package installation | `s17-final-current/summary.json` |
| Manual wake, initial 80-column probe | `ui-manual-wake-final/manual-summary.json` |
| Manual wake at required widths | `ui-wake-{40,100,160}-final/manual-summary.json` |

Reproduce automated reference acceptance after `npm run build`:

```powershell
$env:STAMPEDE_E2E = '1'
node spikes/v1-acceptance.mjs
node spikes/v1-reference.mjs
```

Both commands use signed-in CLIs and normal model usage. Reference acceptance
uses Haiku and gpt-6-luna at low effort, with a $0.50 Claude per-turn ceiling.
The fixture oracle checks workflow execution, not model review quality.

## Remaining desktop checklist and release

Use a local Claude Code-tab session with the plugin loaded and a disposable
Stampede home. Bring Claude to the foreground before Computer Use begins.

- Verify outside-project discovery and authenticated transport.
- Exercise Open, tabs, Pause/Resume, recipient Select, message Input/Enter/Send,
  Retry, Skip, Copy path, Cancel/No/Yes, Close/Escape and alert dismissal.
  Record whether each action responds within one second.
- Verify one owned, attributed completion wake; quoted peer-message wake;
  busy suppression; wake toggle and manual wake.
- Restart the fixture hub and verify reconnection; advertise a mismatched UI API
  and verify the banner. Record unavailable desktop surfaces and apply only the
  specified fallbacks if needed.
- After these pass, set all coupled versions to 1.0.0, rebuild and repeat the
  release checks and isolated packaging check. Commit only the four release
  runtime files (`dist/cli.js`, `dist/worker.js`, `dist/hook.js`,
  `dist/windows-helper.ps1`), excluding generated modules, tests and secrets.
  Verify Windows/Ubuntu CI and create the versioned release tag.

No stable release tag has been created while desktop acceptance is pending.

## Desktop follow-up

The foreground issue is resolved. The live Code-tab pane renders the test run,
agent states, log and Copy result path control. Hub logs record authenticated
desktop event/snapshot requests from bundled Claude Code 2.1.293. The session
received an attributed interrupted-run wake; this does not yet establish the
required successful completion/result-fetch path or the full action checklist.

The first session exposed duplicate MCP discovery: the installed
`plugin:stampede:stampede` connected, while the root `.mcp.json` was also loaded
as plain project server `stampede`, leaving `CLAUDE_PLUGIN_ROOT` unresolved.
MCP configuration is now inline in `.claude-plugin/plugin.json`, and the root
`.mcp.json` is removed. The obsolete local project-server enablement is removed.
Fresh `claude mcp list` shows only the connected plugin server. Strict validation
and isolated packaging pass, including a new check from the plugin workspace
itself. Evidence: `spikes/artifacts/s17-plugin-only-mcp/summary.json`.

The existing desktop conversation predates the installation and still needs its
MCP tools refreshed. Its visible prompt draft was preserved. Remaining desktop
actions and completion/result-fetch verification are not claimed as passed.
