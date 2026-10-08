# Stampede

A local Claude Code plugin for JavaScript workflows over Claude Code and Codex workers. A loopback hub owns runs, worktrees, messages and cached results; the mod provides the pane and session-specific completion wakes.

Release candidate `1.0.0-rc.1` is under qualification. See [V1_STATUS.md](V1_STATUS.md) for remaining release gates and [SPEC.md](SPEC.md) for the contract. Live steering and preemption are outside V1.

The [V1 acceptance audit](V1_ACCEPTANCE.md) maps the requirements to automated,
real-backend and terminal evidence. Live desktop acceptance remains pending.

## Development installation

Requires Node 22+, Git, Claude Code 2.1.292+ and/or Codex 0.159.2+, with the CLI already signed in. The qualified Windows configuration uses Codex's elevated sandbox. Stampede never copies CLI credentials.

```powershell
npm ci
npm run build
node dist/cli.js init
node dist/cli.js doctor
claude plugin marketplace add C:\Dev\Stampede
claude plugin install stampede@stampede --scope user
```

The build produces self-contained CLI, workflow-worker and hook bundles plus the Windows helper; an installed plugin does not need development dependencies. Version coupling is checked during the build.

Use `/reload-plugins` in an existing Claude session. For development, use `claude --plugin-dir C:\Dev\Stampede`. The plugin auto-starts the hub when its MCP server connects. `init` previews the Codex defaults it reads from the user's config and asks before writing Stampede's config. State defaults to `~/.stampede`; set `STAMPEDE_HOME` consistently for the CLI and plugin to use another directory.

The MCP server is declared inside the plugin manifest. Do not register it again
as a project server: `${CLAUDE_PLUGIN_ROOT}` and `${user_config.stampedeHome}`
are resolved by the plugin loader.

Ask Claude to use Stampede and read the bundled `stampede-workflows` skill. Open `/stampede` for run tabs, messages and controls. With the mod disabled, use `workflow_wait` and `workflow_result` through MCP.

## Maintenance

```powershell
node dist/cli.js hub --restart
node dist/cli.js gc
node dist/cli.js gc --worktrees
```

Restart refuses while a run is active; `--force` interrupts it. Retention removes expired terminal artifacts and keeps summaries by default. Worktree collection asks for confirmation, refuses uncommitted changes and keeps branches. Inspect those branches before integrating changes.

Configuration is `STAMPEDE_HOME/config.json`. Project `.stampede/config.json` can only lower numeric limits. Per-run concurrency cannot exceed `max(1, min(16, cpus − 2))`, even when the home config raises the global or backend pools. Read-only is the default access tier. Claude's contained tier denies arbitrary shell tools; Codex uses its sandbox. These controls do not make untrusted JavaScript or model output safe to execute. The state directory is protected by an exact current-user DACL on Windows, with process-ancestry checks as additional hardening.

## Verification

```powershell
npm test
npm run check
claude plugin validate . --strict
claude plugin test .
```

Core tests use local fake backends and temporary repositories. `spikes/` contains explicit real-CLI qualification programs, which consume normal model usage; results are summarized in [spikes/RESULTS.md](spikes/RESULTS.md). Raw artifacts, local Claude settings and generated build-specific mod declarations are ignored by Git. Load the plugin with the installed Claude build to generate `.claude-plugin/types/`, then run `node node_modules/typescript/bin/tsc -p tsconfig.mod.json` for mod type checking.
