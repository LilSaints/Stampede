# Stampede spike results

Measured 2026-10-08, Europe/London. Scope: **S-20–S-23 only**. The other M0 spikes have not been run in this review.

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
| S-13 | Full CLI startup p95 118.04 ms over 30 launches, excluding HTTP time. |
| S-14 | Actual terminal mod read the custom state directory and authenticated to the hub over HTTP. Live desktop and an outside-project mod state directory remain unverified. |
| S-15 | Actual terminal wake was attributed as “Prompt from the stampede plugin”, produced one follow-up turn and retrieved result 42. Busy submission is suppressed; host `drop` preserves pending updates. Deliberately submitting into a busy real turn was not tested. |
| S-16 | Actual terminal pane/band/toast/wake observed. Desktop components and action dispatch pass installed-host renderer tests; actual desktop painting remains pending. |
| S-17 | All launches use generated plugin-disable settings and strict MCP configuration; worker-role recursion guard is present. Exclusion of an already user-installed plugin remains a real-host release check (the plugin is not installed in that scope on this machine). |
| S-18 | Actual `mcp__plugin_stampede_stampede__workflow_run` interception stamped the live Claude session ID and selected the resulting run. Both this prefix and standalone `mcp__stampede__` are supported. |
| S-19 | The actual timer delivered a wake between terminal turns; CAS overlap guard is exercised by fixtures. Live hot-reload re-registration remains pending. |
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
