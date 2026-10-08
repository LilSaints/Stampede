# Stampede spike results

Measured 2026-10-08, Europe/London. The initial S-20–S-23 review is preserved below; subsequent sections record the broader implementation and release qualification.

Environment: Windows 11, Node 24.20.0, Claude Code 2.1.292, Codex CLI 0.159.2. Model probes used Claude Haiku at low effort and Codex `gpt-6-luna` at low effort; the S-22 resumed turn used medium effort to test the override. Claude calls had a $0.50 per-invocation ceiling.

| Spike | Outcome | Build implication |
|---|---|---|
| S-20: Windows caller identity | **Conditional pass.** Both real worker shell ancestry chains were recognized. A persistent helper meets 200 ms; launching PowerShell for each lookup does not. | Start and retain one helper before accepting requests, or leave ancestry hardening off. |
| S-21: interrupted MCP wait | **Pass in one forced-interruption trial per backend.** Both sessions retained their ID and recovered the original nonce after resume. | The tested oneshot preemption path is viable. This is a smoke test, not a reliability/stress qualification. |
| S-22: settings on resume | **Partial pass.** Sandbox, cwd, effort, shell environment, and MCP overrides applied. Changed developer instructions did **not** replace the original developer message. | Keep the agent contract immutable; do not promise arbitrary config replacement on resume. Explicit Windows sandbox configuration is required. |
| S-23: reads outside the workspace | **Yes for ordinary files.** Both modes read a canary under the user's home, outside the workspace. A canary with a strict user-only ACL was denied in both modes. | Neither mode is confined to workspace reads. Do not infer that every user-readable file, or `hub.token` specifically, is readable. |

## S-20 — Windows process attribution

The controller kept each HTTP connection open while the helper looked up its exact IPv4 loopback tuple. It queried `GetExtendedTcpTable`, took a process snapshot, walked parent PIDs, and matched the worker root by PID **and process creation time**. It rejected parent links whose creation time was later than the child's, to avoid treating a reused parent PID as ancestry.

| Measurement | Samples | Correct | p50 | p95 |
|---|---:|---:|---:|---:|
| Persistent PowerShell helper, complete IPC round trip | 60 | 60 | 19.6 ms | 26.6 ms |
| New PowerShell process and helper compilation per connection | 20 | 20 | 990.3 ms | 1,043.9 ms |

Persistent-helper startup took 825.1 ms; it is excluded from warm request latency and must happen before serving traffic. This benchmark used the installed `pwsh.exe`. It does not establish timings for another PowerShell version, `netstat`, CIM, or a loaded machine.

Real worker checks:

- Claude: `curl.exe → Bash processes → claude.exe`; root matched; 59.5 ms including IPC.
- Codex: `curl.exe → pwsh.exe → codex-command-runner → codex.exe → node.exe`; launched root matched; 53.3 ms including IPC. The test explicitly enabled network access for this one localhost request.

This remains best-effort ancestry hardening. The probes do not make process ancestry a security boundary or remove the spec's detached/service-process limitation.

Evidence: [80-connection benchmark](artifacts/s20-native/s20.json), [Claude chain](artifacts/sessions-clean/summary.json), [Codex chain](artifacts/sessions-windows-explicit/summary.json). Implementation: [benchmark](s20-client-process.mjs), [native lookup helper](windows-client-process.ps1). API references: [GetExtendedTcpTable](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable), [PROCESSENTRY32W](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w).

## S-21 — kill during a pending wait, then resume

The fixture MCP server logged entry to `wait_for_message` and withheld its response. After observing that entry, the controller waited 1.5 seconds, used `taskkill /T /F` on its own worker process tree, waited for exit, and resumed the recorded session in the same cwd. The continuation prompt did not repeat the original random nonce and prohibited calling the wait again.

| Backend | Session | Observed continuation |
|---|---|---|
| Claude | `fd772dbc-660f-4779-b49d-6c8b6626e079` | Same session ID, exit 0, exact original nonce, `continued: true`. |
| Codex | `01a1198b-79e9-7ca2-b540-be57bba0066d` | Same thread ID, exit 0, exact original nonce, `continued: true`. |

Neither continuation produced an API or transcript-format error. Codex also emitted a final message saying the wait was still pending before its process exited; this does not constitute a successful wait response. The server-side event and missing tool completion are the evidence that the MCP call remained pending.

This tests a hard kill while a read-only fixture tool is pending. It does not test live-mode interrupts, destructive tools, repeated preemption, or the distinct resolve-the-wait-then-kill race described in §14.5. That race must not be treated as verified by this result: choose the pending-wait kill path or test the alternate sequence separately before using it.

Evidence: [summary](artifacts/sessions-clean/summary.json), [Claude MCP events](artifacts/sessions-clean/s21-claude.mcp.jsonl), [Codex MCP events](artifacts/sessions-clean/s21-codex.mcp.jsonl), and the corresponding start/resume stdout files in that directory.

## S-22 — changed settings on an existing Codex thread

The final test used the spec's legacy `-s` syntax **before** `resume`, with `--ignore-user-config` on both invocations and an explicit `-c windows.sandbox="elevated"`. A separate earlier run confirmed equivalent behavior with named permission profiles.

Thread: `01a11996-1705-7273-a005-7383f3636589`.

| Setting | Initial turn | Resumed turn | Evidence |
|---|---|---|---|
| `-s` | `workspace-write` | `read-only` | Stored turn context changes; initial inside write succeeds, resumed inside write fails with EPERM. Controller independently finds the initial file and no resumed file. |
| `-C` | Fixture workspace A | Fixture workspace B | Both turn context and actual command cwd change. |
| `-c model_reasoning_effort` | `low` | `medium` | Stored turn context changes. |
| `-c shell_environment_policy.set` | `ENV_A` | `ENV_B` | Actual command output contains the new environment value. |
| `-c mcp_servers.stampede.*` | Fixture server A | Fixture server B | New server process starts and the `settings_B` call returns B. |
| `-c developer_instructions` | Marker A | Marker B requested | **Not replaced.** The final reply uses A; the persisted developer messages contain A and no B. |
| `--ignore-user-config` | Supplied | Re-supplied | Accepted on both invocations. This probe did not audit every possible configuration source. |

The unchanged `AgentLaunch` contract remains compatible with these results. Changing role/developer instructions requires a new thread or a separately verified continuation mechanism; the CLI test does not establish that app-server can replace them.

Two additional launch requirements emerged:

1. **Select the Windows sandbox explicitly after ignoring user config.** This machine's saved setting is `windows.sandbox = "elevated"`. Without re-supplying it, the legacy workspace-write launch produced a read-only turn context and shell calls were rejected. A named workspace profile alone produced the intended context but shell calls were still rejected. Supplying the Windows mode enabled execution; the final legacy-flag test then passed its behavioral controls.
2. **Set approval behavior for Stampede's own MCP server.** With only `approval_policy="never"`, the initial wait call returned `MCP tool call requires approval, but approval policy is never`. The corrected fixture uses `mcp_servers.stampede.default_tools_approval_mode="approve"` and accurate tool annotations. This is scoped to the fixture server; it does not authorize arbitrary MCP servers. The relevant settings are documented in the [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Evidence: [final legacy-flag run](artifacts/sessions-legacy-windows/summary.json), [actual tool calls and outputs](artifacts/sessions-legacy-windows/rollout-2026-10-08T04-37-09-01a11996-1705-7273-a005-7383f3636589.jsonl.tool-calls.json), [named-profile run](artifacts/sessions-windows-explicit/summary.json). If the generated rollout filename differs, use the `*.tool-calls.json` and `*.turn-contexts.json` files in the linked run directory.

## S-23 — independent Windows sandbox controls

The direct probe ran `codex sandbox` with `:read-only` and `:workspace`, including managed requirements. It executed a Node script directly so model tool selection, command approval, and PowerShell execution policy could not be mistaken for filesystem enforcement. The successful S-22 real-agent commands independently reproduced the same access matrix.

| Operation | Read-only | Workspace-write |
|---|---|---|
| Read an inside canary | Allowed | Allowed |
| Read a normal home-directory canary outside the workspace | Allowed | Allowed |
| Read an outside canary with inheritance removed and only the user's SID granted FullControl | EPERM | EPERM |
| Write inside the workspace | EPERM | Allowed |
| Write beside the outside canary | EPERM | EPERM |

All canaries were synthetic. No actual credentials, `hub.token`, or unrelated user files were read. Temporary home-directory fixture folders were removed, and zero `.stampede-spike-*` directories remained at final inspection. Saved artifacts contain the observations and non-secret nonce values.

This result supports “not confined to workspace reads”; it does **not** support the stronger statement that a sandboxed Codex command can do everything the user can. File ACLs and write restrictions mattered in these tests. MCP server processes are a separate trust surface and were not covered by this filesystem test.

Evidence: [direct sandbox results, including ACL and write controls](artifacts/s23-confirmed/s23.json), [real agent confirmation](artifacts/sessions-legacy-windows/summary.json). Probe: [s23-windows-sandbox.mjs](s23-windows-sandbox.mjs).

## Implementation qualification — 2026-10-08

Additional probes use Claude Code 2.1.292 and Codex 0.159.2. They are synthetic and retain raw output only in ignored local artifact directories.

| Probe | Observed result | Consequence |
|---|---|---|
| S-1/S-2, `m0-launch.mjs` | Claude settings PostToolUse hook ran, inherited a nonce, and returned it to the model. MCP wait completed after 45,007 ms. | Claude hook and 45-second wait path retained. |
| S-3/S-4/S-5 | Codex MCP configuration and developer instructions worked. Hook output was absent with ordinary flags, trust bypass, and a corrected regex matcher. | Codex uses explicit reads/waits and idle resume; hook delivery is not advertised. |
| S-7, `s7-shared-home.mjs` | Eight concurrent conversations, each started then resumed twice: all 24 turns passed, IDs and original nonces matched, no database-lock/corruption signatures. | Shared CODEX_HOME retained, default concurrency 6 is within the observed 8. No authentication files copied. |
| S-13, `s13-hook-startup.mjs` | 30 Windows hook launches: median 92.67 ms, p95 118.04 ms, max 122.37 ms. | Full CLI entry meets the 150 ms startup target; measurement excludes a hub round trip. |
| Real pipeline, `v1-e2e.mjs` | Claude Haiku returned schema-conforming data, then Codex gpt-6-luna returned it unchanged. | Actual mixed-backend pipeline passed. |
| Real team, first attempt | Codex coordinated, but Claude obeyed plan-mode instructions prohibiting mutating MCP tools. Team hit its observation deadline. | This attempt failed the team acceptance test despite the containing workflow ending normally. |
| Real team, corrected permission profile | Both workers posted a board finding, sent an orchestrator message, read messages, marked done and returned `checked`. Observation ended `all-terminal`. | Read-only Claude workers with comms use default permission mode, explicit allowed coordination/read tools, and explicit file-edit/shell denials. Non-comms read-only workers still use plan mode. Tool annotations remain truthful. |

Local evidence: `artifacts/m0-launch-20261008/summary.json`, `artifacts/m0-codex-trusted-hooks-20261008/summary.json`, `artifacts/m0-codex-regex-hooks-20261008/summary.json`, `artifacts/s7-shared-home-20261008/summary.json`, `artifacts/s13-hook-startup-20261008/summary.json`, `artifacts/v1-e2e-20261008-fixed/summary.json`, and `artifacts/v1-e2e-20261008-coordination/summary.json`.

The installed Claude plugin harness also passes pane tests for terminal/desktop at widths 40/100/160, session-ID injection through `tool.call`, owner/seen-cursor wake filtering, debounce/busy/rate-limit behavior, and a 1,000-agent bounded-tree fixture. These validate host API behavior with fixtures, not manual painting or real desktop prompt submission. Interactive transport/wake checks remain a release gate.

## Reproducing the probes

Run from the repository root in an environment permitted to start the local CLIs and make loopback connections. The session probes use the existing CLI login and create normal CLI session records. They do not edit saved user configuration or copy credentials. Use a fresh output directory for each run.

```powershell
node spikes/s20-client-process.mjs spikes/artifacts/s20-rerun

$env:STAMPEDE_PROBE_WINDOWS_SANDBOX = 'elevated'
$env:STAMPEDE_PROBE_PERMISSIONS = 'legacy'
node spikes/s21-s23-sessions.mjs spikes/artifacts/sessions-rerun

node spikes/s23-windows-sandbox.mjs spikes/artifacts/s23-rerun
```

The session harness removes invoking-desktop identity/IPC/permission-profile environment variables before starting its separately configured workers; authentication locations are preserved. It also removes the inherited `PSModulePath` so Windows PowerShell can locate its own modules. The initial Claude harness used `--bare`, which intentionally disables OAuth/keychain login; the corrected harness omits it and keeps settings/MCP configuration isolated instead.

Diagnostic attempts are retained alongside the final evidence. A completed harness run is not itself a pass for every assumption; use the observations and verdicts above. There is no product implementation in these probes.

## Final capability and host matrix — 2026-10-08

| Spike | Evidence or selected fallback |
|---|---|
| S-1/S-2 | Passed real Claude hook/context/env and 45-second MCP wait probes. |
| S-3 | Per-call Codex hooks were not usable in the tested forms. D3/D5 polling and idle resume are selected; hook delivery is not claimed. |
| S-4/S-5 | Real Codex per-call MCP configuration and developer instructions passed. Unqualified versions use prompt contracts and reject unqualified MCP coordination. |
| S-6 | Both file and `@file` arguments were rejected as invalid JSON. Inline schema with the 24,000-character guard is selected. |
| S-7 | Eight concurrent conversations × three waves passed. Unqualified versions are limited to one process. |
| S-8 | Normal and killed real streams were observed. Auth, timeout and failure paths also have fake-backend coverage. Real rate-limit/overload/auth event variants were not deliberately induced; exit status and stderr classification remain the conservative fallback. |
| S-9 | gpt-6-astra accepted low, medium, high, xhigh and max; each returned valid constant JSON. No effort remapping is needed for 0.159.2. |
| S-10 | Strict normalization is always selected; 200 optional-property/ref round trips pass, unsupported ambiguous unions reject before launch, and actual schema pipeline calls pass. Raw server acceptance of every unnormalized schema feature is not claimed. |
| S-11 | Not exercised: live-mode delivery is M6, outside the implemented V1. `liveMidTurn=false`. |
| S-12 | Doctor's actual Windows sandbox controls pass: inside read/write, outside write denial, and denial of a synthetic file under the protected Stampede state root. Exact ACL verification passed. |
| S-13 | Selected dedicated `dist/hook.js`: 30 launches, p95 149.56 ms (startup only, excludes HTTP). The bundled full CLI missed the target under the later workload. Evidence: `artifacts/s13-dedicated-20261008/summary.json`. |
| S-14 | Actual terminal mod read outside-project state and authenticated to the hub over HTTP; restart reconnection also passed. Evidence: `artifacts/host-probe.json`. Live desktop remains unverified. |
| S-15 | Actual terminal wake was attributed as “Prompt from the stampede plugin”, produced one follow-up turn and retrieved result 42. Busy submission is suppressed; host `drop` preserves pending updates. Deliberately submitting into a busy real turn was not tested. |
| S-16 | Actual terminal pane/band/toast/wake observed; worker controls and run tabs pass at 40/100/160 columns. Manual Wake now passes in live terminals at 40/100/160 columns (see final acceptance below); actual desktop painting/actions remain pending. Desktop components and action dispatch pass installed-host renderer tests. |
| S-17 | Fresh bundles install in a disposable user-scope configuration with no dependencies or copied credentials. MCP connects; generated plugin-disable settings remove its MCP server; packaged workflow returns 42. Evidence: `artifacts/s17-current-24afad0/summary.json`. Strict MCP configuration and worker-role recursion guard remain in place. |
| S-18 | Actual `mcp__plugin_stampede_stampede__workflow_run` interception stamped the live Claude session ID and selected the resulting run. Both this prefix and standalone `mcp__stampede__` are supported. |
| S-19 | The actual timer delivered a wake between terminal turns and re-registered after live hot reload, reconnecting to the restarted hub's new port. Evidence: `artifacts/host-probe.json`. CAS overlap guard passes fixtures. |
| S-20 | Original ancestry probe passed with the persistent helper; implementation recovery checks also reject a mismatched creation identity and terminate the exact orphan instance. |
| S-21/S-24 | Preemption is outside V1. Original S-21 smoke observations are retained; they do not qualify the deferred preemption barrier. |
| S-22/S-23 | Original immutable-resume and sandbox/ACL controls passed; doctor now repeats synthetic state-ACL/readiness controls per changed backend version. |
| S-25 | Exact production shell/hook network behavior remains unverified. No shell network-denial claim is made. The real mixed team proves that its actual agent MCP processes could contact the hub. |

Additional local evidence (ignored, not published):

- `artifacts/s6-options-20261008-fixed/summary.json`: corrected schema-file probe. The earlier S-6 attempt lacked the variadic-argument separator and is not evidence of schema support.
- `artifacts/s6-s9-options-20261008/summary.json`: all five effort levels.
- `artifacts/doctor-20261008/final-doctor.json`: exact ACL, readiness and protected-state canary results.
- `artifacts/setup-maintenance-20261008/probe-summary.json`: initialization, duplicate hub, restart refusal/force recovery and retention.
- `artifacts/plugin-connect-20261008/`: real plugin MCP doctor, tool-prefix and ownership check.
- `artifacts/terminal-ui-20261008/`: real terminal run and seen-cursor state. Session `4d1bdbe1-7f6b-4ca3-aab9-f9750cd2ebef`, run `run_01M4D2RES17PR4XS6D96B18TDV`, result 42. The probe session exited and its hub was shut down.

The 15 mod tests and 27 core tests pass. The integration suite additionally verifies that mark_done does not publish an early result: an observation times out with null, run-end drain then stores the delayed final answer. No actual Claude calls were made after the terminal reported 98% weekly usage. Outstanding host checks are tracked in `V1_STATUS.md`; this matrix is not a claim that unperformed probes passed.

## Host and standalone packaging completion

A further zero-model-call terminal probe (session `4118bc99-6336-4978-9b34-ff6b4fd92657`) passed S-14's outside-project state access and S-19's hot reload: the live mod reloaded seven hooks and its timer reconnected from the old hub port to a newly started hub on a different port. An authenticated UI fixture then advertised UI API 999; the actual terminal pane displayed the version-mismatch banner. Both fixtures exited and their temporary state was removed. Evidence: `artifacts/host-probe.json`. These results supersede the earlier pending terminal cells; desktop and manual multi-width/action checks remain pending.

S-17 now passes for an actual isolated installation. `s17-package.mjs` installs the plugin into a disposable `CLAUDE_CONFIG_DIR` and separate plugin cache, without credentials or `node_modules`. The enabled control reports `plugin:stampede:stampede` Connected; the generated `enabledPlugins` override yields No MCP servers configured. The packaged hub's worker returns 42. Both the initial corrected probe and the final `1.0.0-rc.1` candidate pass; temporary installations and hubs were removed. Evidence: `artifacts/s17-package-rc1-20261008/summary.json`. The first attempt used an invalid combination of qualified plugin name and `--marketplace`; it failed before installation and was corrected.

Packaging revealed two issues, both corrected before release qualification:

- Plain TypeScript output depended on the development dependency tree. `scripts/build.mjs` now bundles the CLI, workflow worker and hook, copies the Windows helper, and verifies package/plugin/hub/UI-major version coupling. The standalone installation probe proves the resulting four runtime files work without `node_modules`.
- The bundled full CLI hook measured 182.31 ms p95 during the concurrent core-suite run, missing the 150 ms target. Workers now invoke the dedicated `dist/hook.js` entry. A subsequent 30-launch measurement gives median 123.54 ms, p95 149.56 ms and max 168.09 ms (startup only, hub round trip excluded). Evidence: `artifacts/s13-dedicated-20261008/summary.json`. Integration also verifies this entry prints two actual claimed messages and only then acknowledges both as handed.

The final post-packaging core run passed 27 tests; the dedicated-hook change additionally passed the targeted hub integration test. Strict plugin validation and both TypeScript projects pass for the release candidate. The 15 mod tests passed on the unchanged UI code. These are still qualification results, not a final release declaration.

## Windows/Ubuntu CI and live terminal widths

The spec's CI requirement was missing from the initial candidate. `.github/workflows/ci.yml` now runs the core suite on Node 22 with both `windows-latest` and `ubuntu-latest`; both jobs passed in https://github.com/LilSaints/Stampede/actions/runs/37741506755 for `c5e969a`. The workflow has read-only contents permissions and no model credentials.

A live terminal was resized with the console API (`mode con`); Node reported the requested 40-column TTY. Actual Claude sessions were then exercised at 40, 100 and 160 columns against `ui-host-fixture.mjs`, using fake workers and zero model calls. The 40-column pane has only 38 body columns: this exposed a real breakpoint defect that hid agent rows and Retry/Skip controls. The view now stacks narrow agent rows and retains their controls; regression fixtures include 38 columns. The action handler also preserves an open draft when Pause/Retry completes and uses a compare-and-set guard; polling no longer clears a still-pending action.

Observed controls across the live widths: Pause/Resume, broadcast through Input Enter, Select recipient plus Send button, Retry, Skip, clipboard OSC52 with the result path, Cancel dismissal, composer Close, composer Escape, and confirmed cancellation. Mutation responses were visible in the 250–270 ms tool observation window. The terminal fixture ended cancelled (alpha cancelled, beta skipped) and was shut down; all three CLI sessions exited. Local evidence: `artifacts/ui-widths-20261008/manual-summary.json` and its durable run events. Clipboard emission was observed; no unrelated clipboard content was read. Not every action was repeated at every width, and this does not verify the desktop Code tab.

The revised UI passes 19 installed-host tests, mod type checking and strict validation. A broader spec audit identified remaining integration-coverage gaps beyond manual UI acceptance; they are explicitly recorded in `V1_STATUS.md` rather than hidden behind the aggregate test count.

## Real-shim fake workers and cache validity

Fake Claude and Codex entry points now launch through their production adapters and generated MCP configurations. Coordination fixtures use the MCP SDK over stdio to the actual bundled agent shim. The mixed-worker integration checks 600 strictly ordered unique deliveries, committed after normal turns, non-comms progress during a mutual-wait deadlock, and one resume containing an idle two-message burst. Both adapters also pass schema pipeline, failed judge slot and bounded-loop scenarios. This is a process-level sample; the separate 1,000-seed bus test is not represented as 1,000 process-level schedules.

These checks exposed teardown writes continuing after hub shutdown and stopped teams retaining queued admission. Cancellation now joins worker tasks, gang admission and final persistence; stopped queued gangs are aborted. An initial idle-resume assertion observed the incremented resume counter before the new turn began; the corrected test waits for the second stored result and then verifies the count is exactly one.

The cache integration uses an isolated temporary Git repository to prove identical-call hits, one live call after one prompt changes, reviewed-file and cacheInputs invalidation, kept-branch verification after a new commit, shared-edit exclusion and read_board taint through the real MCP shim. No model calls or user credentials are used. Combined core coverage is now 30 tests; live desktop verification, exact real-CLI scenarios and the remaining §24 fault/audit requirements remain release gates.

The subsequent delivery-fault integration passes four actual transport failures through a local HTTP proxy: dropped read_messages response, shim killed after its stdout result, hook killed before printing, and hook killed after printing before acknowledgement. Each lease expires; a fresh real shim receives all three messages in order with redelivery flags. The actual fake worker is then killed after handoff, retries with the ordered flagged suffix in stdin, and commits only after normal completion. This raises local core coverage to 31 tests. CI on both platforms exposed a cache-fixture capacity assumption on small runners; cache and fault fixtures now set explicit scheduler capacity instead of inheriting CPU-derived defaults.

Windows ACL integration adds an inheritable Everyone grant, protected descendant grants, and CodexSandboxUsers access when that local group exists. Actual hub startup repairs these to the exact current-user DACL with inherited-only descendants, independently inspected with PowerShell. A subsequent explicit child-file grant is repaired on restart. Doctor rejects a synthetic state junction before probing backends. The test uses only owned temporary files, and skips on non-Windows platforms. Local core coverage is now 32 tests.

CI passed the cache/fault suite on Windows and Ubuntu at `859e29d`. The ACL test initially compared a short Windows temporary path with PowerShell's expanded path; canonical comparison fixed it and the Windows CI ACL test passed at `29df39f`. That run exposed a remaining teardown cleanup failure. Hub close now joins in-flight HTTP requests, interval maintenance, run tasks and serialized events; repeated close calls share one completion promise and new runs are rejected during shutdown.

The mixed-process test now supports 1–1,000 seeded schedules through `STAMPEDE_CONCURRENCY_SEEDS`, with seeded send/read jitter, continuous quiescence observations, per-schedule reserve/resume assertions and bounded fixture-log retention. Two seeded schedules passed before adding continuous quiescence observations; the full 1,000-process-schedule result remains pending. The separate 1,000-seed bus result remains valid.

`v1-acceptance.mjs` prepares the remaining real peer exchange, resume on each backend and batch-of-six scenarios. Its syntax check passes. Automatic approval review rejected launching it due to authenticated network/model usage costs; explicit approval was requested, so no real calls were made by this new runner.

The installed Claude Code 2.1.292 executable contains the Workflow authoring reference. Static inspection recovered the actual review-changes and loop-until-dry control flow and the prose judge-panel pattern, without starting a model session. `reference-parity.spec.ts` ports those examples with deterministic schemas/prompts: both fake backends pass confirmed/rejected finding verification, seen-set deduplication including rejected findings, two dry rounds, three-lens majority voting, phase order and winner-plus-runners-up synthesis. This adds one test (33 local core tests). The 1,000-process-schedule qualification is running with progress in `artifacts/mixed-process-1000-20261008.log`; its first 25 schedules passed. Windows CI at `b1718ab` passes ACL repair but still fails the reserve-progress scenario with an absent result; assertions now report the underlying run and agent errors instead of a property-access error.

The next Windows run passed reserve progress but exposed an idle-release completion race: agent status became terminal before its background finalizer released the reservation. Team terminal observation, run-end drain and cancellation now join that finalizer. A regression holds durable termination behind a gate and verifies workflow_wait remains running with the reservation held until the gate opens, then completes with no held slots. The general hub fixture now uses an isolated workspace rather than fingerprinting the development checkout.

The implementation audit also found missing §16.4 details. Fingerprints now use a per-run TTL memo and shared writer generations; resume gets a fresh memo, while a writer invalidates other active runs. Live queued teams refresh call/team keys at admission. Regression checks prove TTL expiry, cross-run invalidation, immediate edit-then-resume correctness, and replay after a queued team observes another run's write. Journals now record shared reads/writes and external web/MCP tool names from both adapter transcript formats; cache reports carry external dependency names, excluding tool arguments/results and Stampede's own MCP calls. The full 35-test run passed, followed by six integration checks including the new queued-team regression (36 total tests). The long mixed-process qualification has passed 150 schedules and remains in progress.

Windows and Ubuntu CI both passed all applicable tests at `6f2a889` in run https://github.com/LilSaints/Stampede/actions/runs/37751517061, including the idle-finalization fix. The next audit found that USD admission ignored agent-type model defaults and opts.phase-only agents could be absent from the pane. Effective-model pricing and automatic phase registration now pass focused tests. Child workflows also now keep phase groups scoped under `▸ name`, observe live shared budget counters, reject a second nesting level, and share parent cancellation. Parent finalization stops outstanding child runtimes. Two runtime integration tests pass alongside the reference parity test (38 total local tests). The long qualification reached 200/1,000 schedules; no real model calls were made.

The next UI audit adds owned running/waiting counts, completed-run unread visibility, run ID/elapsed/budget headings, phase state counts, activity text, dimmed offline rows, dismissible authentication alerts and compactBand preference handling. Toasts arriving within five seconds are queued and coalesced on a later poll; the wake limit emits one rate-limited warning and offers Wake now. A full composer reduces visible agent rows with an explicit hidden-row count to retain the 20,000-character payload bound. All 22 installed-host plugin tests, mod type checking and strict validation pass. Windows and Ubuntu core CI passed at 3fb92be; the separate mixed-process qualification reached 275/1,000 schedules and remains running.

All 41 core tests pass in one Windows run against the separate verification build (46.7 seconds). New coverage includes both adapters receiving 100 KB UTF-8 stdin with executable-entry/workspace paths containing spaces, Windows process-tree cancellation, synthetic EBUSY rename retries and exhaustion preserving the old snapshot, and eight parallel fake workers editing and snapshotting worktrees. The worktree fixture initially overcounted porcelain entries because its path contained the word worktree followed by a space; line-based parsing corrected that fixture assertion. Status now isolates the latest five orchestrator messages from peer chatter, reports queued-team idle reservation holders, uses the documented phase agents-count shape, and counts undeliverable deliveries from live state or durable history. Its HTTP regression verifies independent observer/owner read cursors. CI at 40bb8ad passed on Windows and Ubuntu. The long qualification reached 350 schedules and remains running.

The actual hub-crash regression passes locally: a separate hub is killed with SIGKILL while both a fake Claude and fake Codex worker are alive. After restart, the run is interrupted and no workers remain; workflow_resume reuses the completed non-comms call (one cache hit), launches a fresh team (two live calls), and stores both marked-done results. On this Windows host both workers exit with the hub, so this run does not claim that restart killed surviving orphans; the separate exact-identity recovery regression supplies that evidence. The fixture records the number surviving the crash on each platform. Local coverage is now 42 core tests across the preceding full run and this added regression. Both CI platforms passed at 36e02ca, and the long mixed-process qualification reached 400/1,000 schedules.

CI run 37756688722 passes at da31a6d: Windows passes all 42 tests; Ubuntu passes 40 and skips two Windows-only checks. The actual crash test records zero surviving workers immediately after the hub kill on Windows and two on Ubuntu. Ubuntu then verifies that restart removes both surviving workers, marks the run interrupted, and resumes with one cache hit and two fresh team calls.

The worker-control checklist was independently repeated in real Claude terminal sessions at 40, 100 and 160 columns: Pause/Resume, recipient Select, Send button, Enter-send, Retry, Skip, Copy result path (OSC52), composer Close/Escape, and Cancel/No/Yes. Responses were observed within the 320 ms tool window. The 160-column host seats the pane in the right sidebar. Each fixture finished cancelled with alpha cancelled and beta skipped; the terminal sessions and isolated hubs exited. No model prompts were submitted. Local evidence is in artifacts/ui-matrix-{40,100,160}-20261008/manual-summary.json and the corresponding durable run events. An attempted rapid adjacent click in the 100-column confirmation selected the Yes text through the host's double-click behavior; a subsequent ordinary click cancelled successfully. The live checks exposed a brief elapsed-time reset when actions invalidated lastPoll. The view now reads the host clock, and all 22 plugin tests, type checks and strict validation pass; the 100/160-column sessions verified the fix. Desktop and remaining manual band/run-tab checks stay pending. The long transport qualification reached 500/1,000 schedules.

The remaining free band/run-tab checks pass in the real terminal at 40/100/160 columns. At 40 columns, stacked tabs fix clipped later runs; manual Open and /stampede request keyboard focus so number hotkeys switch runs. Automatic first-run pane opens retain the default focus behavior. Band Open, auth-alert Dismiss, completed-run inbox visibility, coalesced toast and wake-limit warning were observed; no Wake now or model prompt was submitted. The same owned fixture was resumed at each width, then all CLI sessions and its hub exited. Evidence: artifacts/ui-band-40-20261008/manual-summary.json. All 22 plugin tests, mod type checking and strict validation pass. A new literal 30-second final-output test passes with four mixed fake workers: mark_done does not resolve agent()/untilDone or finish a draining run until results are stored in run.json. CI at 93ab048 passed both platforms; the mixed-process qualification reached 600/1,000 schedules and remains running.

The §7.4/§14.1 audit found that home configuration could raise scheduler.perRun beyond the Workflow ceiling. loadConfig now clamps it to max(1,min(16,cpus-2)) and revalidates reservation fit. A local regression passes for high home pools, preserved lower caps, rejected project increases and invalid reserves. Core TypeScript compilation passes. The mixed-process run reached 625 schedules; no real model calls were used.

The complete 44-test core suite passes locally on Windows against the separate verification build (63.5 seconds), including the new configuration ceiling and 30-second completion cases. The runtime shim remains the frozen build used by the long qualification. CI run 37760494670 at 8e13227 passes 43 tests on Windows and 41 applicable tests on Ubuntu (two Windows skips). The spec's UI qualification version is corrected to the actually observed Claude 2.1.292; desktop qualification is explicitly pending.

CI at b6075b7 (run 37761233826) passes all 44 core tests on Windows and 42 applicable tests on Ubuntu. The retry audit found that the final rate-limit/overload error skipped backend-wide cooldown after exhausting attempts. Cooldown/event handling now precedes that exit. A real-adapter fake-worker regression passes all six rate-limit failures, six cooldown events and the exact five jittered backoffs, with only retry sleeps accelerated. A scheduler regression verifies active permits are retained while queued capacity restores by one after 60 seconds and every 30 seconds afterward. The two new tests pass locally. The long mixed-process qualification reached 675/1,000 schedules.

The team-admission audit reproduced a partial-roster failure: a later Codex member with unqualified messaging rejected after an earlier Claude member had already registered, so catching the error and reusing that name failed the workflow. Messaging, names, workspace paths and topology are now checked before member creation; preparation commits its lifetime counter only after construction succeeds. The integration passes five invalid-team cases with no residual teams, members, counters or reservations, followed by successful name reuse. A valid member named constructor also works with an empty explicit topology map; lookup is restricted to own properties. The runtime integration suite passes locally, and the long mixed-process qualification reached 700/1,000 schedules.

CI run 37762458662 at 24afad0 passes all 47 tests on Windows and 45 applicable tests on Ubuntu. Fresh current-source bundles were built separately under artifacts/release-candidate-24afad0/dist, leaving the long probe's original dist untouched. The package probe now accepts an optional runtime directory. With these current bundles, isolated plugin installation, MCP connection, disabled-plugin MCP exclusion and a workflow returning 42 all passed without node_modules or copied credentials. No model calls were submitted, and the fixture was removed. The artifact manifest records source commit, version, sizes and SHA-256 hashes; artifacts/s17-current-24afad0/summary.json records the package result. The mixed-process qualification reached 750/1,000 schedules and remains live.

The remaining explicit lifetime boundary now has direct runtime evidence: 999 terminal agent records retain their lifetime count; a two-member team rejects without allocating either member; admission of the 1,000th succeeds; the next agent() rejects across the workflow worker RPC. No backend processes are launched. The same runtime test file confirms 4,096 parallel/pipeline entries succeed and 4,097 reject before any callback RPC. All seven runtime unit tests pass, bringing coverage to 48 tests across the previously verified full run and additions.

The pending real-CLI runner now requires evidence beyond final model claims: exact three-message contents and destinations per peer, at least one Claude mid-turn hook delivery, unchanged backend session IDs on message-driven resume, and temporal overlap of all six batch turns. The Claude prompt includes bounded non-consuming roster polls to allow hook injection. Syntax checking passes; execution remains unapproved and no real calls were made. This runner still does not substitute for unchanged built-in reference-example E2E acceptance. The current capability matrix is reconciled with the already saved host, dedicated-hook and fresh-package evidence so its S-13/S-14/S-17/S-19 rows no longer repeat superseded pending claims.

The desktop-access audit found a supported path beyond CUA: the bundled Windows Computer Use skill initializes @oai/sky through node_repl. Initialization and list_apps succeeded and located one running Claude desktop window. get_window_state then returned 'Computer Use app approval timed out'; no desktop pixels or actions were obtained. The earlier statement that no tool could operate the surface is superseded by this specific per-app approval dependency. Desktop access approval has been requested separately from model-usage approval.

The full mixed-process qualification finished successfully: all 1,000 seeded schedules passed, 600 ordered/unique/committed worker deliveries each (600,000 total), plus reserve-progress, deadlock, idle-burst single resume and queued-team stop in each schedule. Process exit code 0; duration 10,664.98 seconds. Evidence: artifacts/mixed-process-1000-20261008.log. This long test used its original frozen b1718ab-era modules/shim; later implementation changes were checked by current-source CI and focused regressions. CI run 37763740426 at e947a7b passes all 48 tests on Windows and 46 applicable tests on Ubuntu. Normal dist can now be rebuilt without changing the completed qualification's runtime.

After the long qualification exited, npm test rebuilt the normal current-source runtime bundles and all 48 core tests passed locally on Windows (55.7 seconds). All 22 installed-host plugin tests and strict plugin validation passed again. No real model calls were made. Remaining live desktop access is waiting for Computer Use app approval; real Claude/Codex acceptance is waiting for explicit model-usage approval. No V1 tag or release has been created.

## Final real-backend and terminal acceptance - 2026-10-08

The previously unexecuted `v1-acceptance.mjs` now passes all four scenarios on signed-in CLIs: exact three-message peer exchange with three Claude hook deliveries, stable-session message resume on each backend, and temporal overlap of all six batch turns. Every peer delivery committed. Evidence: `artifacts/v1-acceptance-final/summary.json`.

`v1-reference.mjs` runs the same shared control-flow/schema fixtures as the fake parity suite. Reference placeholders are instantiated with synthetic facts and explicit low-effort model options; no review-quality claim is made. Review-changes (4 workers), loop-until-dry (12 workers) and judge-panel (7 workers) pass independently on real Claude and Codex: 46 worker calls. Evidence: `artifacts/v1-reference-final/summary.json`.

The actual terminal Wake now button passes at 40, 100 and 160 columns. Each fixture configures zero automatic wakes; one click submits one prompt with transcript origin `{kind:"plugin",name:"stampede"}`, includes the quoted peer message, and receives `received`. Pending wake controls disappear, sessions exit, runs are cancelled and hubs shut down. Evidence: `artifacts/ui-wake-{40,100,160}-final/manual-summary.json`. An initial 80-column probe is retained separately.

Fresh local checks pass: 48 core tests, 22 plugin tests, strict validation, core/mod TypeScript, and isolated installation without node_modules. The full core run initially exposed a long-poll timeout assumption under load; polling now waits for terminal status within a bounded deadline, and the full rerun passes in 62.4 seconds. Fresh packaging connects MCP, verifies worker exclusion and returns 42; evidence: `artifacts/s17-final-current/summary.json`.

Desktop discovery and state inspection now work, but activation failed twice after refreshing window selection. The live desktop checklist remains blocked on bringing Claude's Code tab to the foreground. [V1_ACCEPTANCE.md](../V1_ACCEPTANCE.md) records the requirement audit and remaining release sequence. These results supersede earlier pending real-backend and terminal-wake statements; no stable release or desktop acceptance is claimed.
