# Repository Guidelines

## Project Overview

**ocv-tools** (package name: `ocv-agent`) is a zero-dependency automated code-review pipeline for feature branches. It scans configured git repos, delegates review to an external AI agent (`omp`), auto-fixes critical/high findings, pushes fix branches, and creates PRs on Gitee or GitHub. An Electron desktop GUI wraps the CLI for config management and run monitoring.

## Architecture & Data Flow

Two-process design with no runtime dependencies:

```
┌─────────────────────────────────┐
│  Electron GUI (app/)            │  Thin shell — config editing, log streaming
│  main.js → spawns bun ocv.ts   │  IPC bridge to renderer
└────────────┬────────────────────┘
             │ child_process / stdout
┌────────────▼────────────────────┐
│  Bun CLI (src/ocv.ts)           │  Entry point + CLI arg dispatch
│  src/lib/*.ts                   │  Modular business logic
│  fetch → scan → review → fix   │  Worker pool for concurrent branch processing
│  → push → PR → report          │
└────────────┬────────────────────┘
             │ subprocess
┌────────────▼────────────────────┐
│  omp (external headless agent)  │  Performs actual code review, returns findings.json
└─────────────────────────────────┘
```

**Pipeline**: Load config → fetch repos → discover feature branches (glob + age filter) → for each candidate: create worktree + branch → invoke omp with structured prompt → parse findings.json → auto-fix critical/high → commit → push → create PR (Gitee API v5 / GitHub REST) → generate Markdown report.

## Key Directories

| Path | Purpose |
|------|---------|
| `src/ocv.ts` | **CLI entry point** — arg parsing, subcommand dispatch (~80 lines) |
| `src/lib/` | **Business logic modules** — split by domain |
| `app/` | **Electron GUI** — main process, preload bridge, renderer UI, HTML shell, styles |
| `reports/` | Generated Markdown review reports (per-date, with INDEX.md) |
| `.wt/` | Git worktrees for branch isolation (gitignored) |
| `.run/` | Run artifacts (gitignored) |

### `src/lib/` Module Map

| Module | Responsibility | Key Exports |
|--------|---------------|-------------|
| `types.ts` | All shared interfaces and type definitions | `Config`, `Finding`, `Candidate`, `BranchState`, `State`, … |
| `constants.ts` | Path constants, CLI usage text | `ROOT`, `CONFIG_PATH`, `STATE_PATH`, `WT_DIR`, `RUN_DIR`, `REPORT_DIR` |
| `utils.ts` | Pure utility functions, zero IO | `die`, `globToRe`, `slugOfRepoBranch`, `escapeCell`, `isSeverity` |
| `config.ts` | Config loading, JSON persistence, secret resolution | `loadConfig`, `loadJson`, `saveJson`, `secretValue` |
| `git.ts` | Git binary resolution, subprocess execution | `resolveGit`, `sh`, `git`, `gitOrNull`, `childEnv` |
| `pr.ts` | Remote URL parsing, PR creation (Gitee/GitHub) | `parseRemote`, `prKindFor`, `createPr` |
| `scan.ts` | Branch discovery and filtering | `pickBase`, `scanRepo` |
| `agent.ts` | omp agent dispatch, prompt construction | `resolveAgentBin`, `buildPrompt`, `runAgent` |
| `findings.ts` | findings.json parsing, severity counting | `readFindings`, `countBy` |
| `report.ts` | Markdown report generation, INDEX writing | `buildReport`, `buildPrBody`, `writeIndex` |
| `pipeline.ts` | Core per-candidate lifecycle orchestration | `processCandidate` |
| `commands.ts` | CLI subcommand implementations | `cmdStatus`, `cmdRun`, `cmdAdd` |

### Dependency Graph

```
ocv.ts → commands → pipeline → scan, agent, findings, report, pr
                  → config, utils, constants
       → config, git, utils, constants

config  → constants, utils, types
git     → constants, utils, types
pr      → config, types
scan    → git, utils, types
agent   → git, utils, constants, types
findings→ config, utils, types
report  → findings, utils, constants, types
pipeline→ git, scan, agent, findings, report, pr, utils, constants, types
commands→ config, scan, pipeline, report, utils, constants, types
```

## Development Commands

```bash
# Run CLI directly (Bun executes .ts natively — no build step)
bun run src/ocv.ts

# CLI subcommands
bun run src/ocv.ts add <repo-path>     # Register a git repo for review
bun run src/ocv.ts status              # Show review history
bun run src/ocv.ts config              # Dump effective config as JSON
bun run src/ocv.ts run                 # Execute the full pipeline

# Launch Electron GUI
bun run app
# or
electron .

# Install Electron binary (China mirror)
bun run setup:electron
```

## Code Conventions & Common Patterns

### General
- **Zero dependencies** — CLI uses only Node.js built-ins (`child_process`, `fs`, `path`, `url`) and Bun APIs (`Bun.spawn`, `import.meta.dir`). No npm packages at runtime.
- **No build step** — Bun runs `.ts` directly; no `tsconfig.json`, no bundler, no transpilation.
- **No linting/formatting** — No eslint, prettier, or biome configured.
- **Modular architecture** — Business logic split into focused modules under `src/lib/`. Each module owns one domain concern and exports a narrow public API.

### Naming
- Interfaces: PascalCase (`Config`, `Finding`, `BranchState`, `Candidate`)
- Functions: camelCase, descriptive verbs (`scanBranches`, `createPR`, `runAgent`)
- Files: lowercase, descriptive (`ocv.ts`, `git.ts`, `pipeline.ts`)
- Config keys: camelCase in `ocv.config.json`
- Type-only imports: `import type { X } from "./y"`

### Module Design Principles
- **Types at the bottom of the dependency graph** — `types.ts` imports nothing, everything imports it.
- **Constants are pure** — `constants.ts` only computes paths from `import.meta.dir`.
- **Utils are pure functions** — no IO, no side effects, no module-level state.
- **Git module owns mutable state** — `GIT` and `GIT_DIR` are module-level, set once by `resolveGit()`, used by all `sh()`/`git()` calls.
- **Pipeline is the orchestration seam** — composes scan, agent, findings, report, pr. Commands delegate to pipeline.
- **No barrel files** — direct imports between modules, no `index.ts` re-exports.

### Error Handling
- Try/catch around subprocess execution and API calls
- Failed branches logged and skipped (pipeline continues)
- Agent timeout configurable (default 40min)
- PR creation has manual fallback on API failure

### Async Patterns
- **Worker pool**: `Promise.all` over N async functions pulling from a shared cursor index — simple concurrency control (configurable, default 2)
- **Subprocess**: `Bun.spawn` for agent invocation, `child_process.execSync` for git commands
- **Electron IPC**: `contextBridge` with strict `contextIsolation`, no `nodeIntegration`

### State Management
- File-based JSON throughout:
  - `ocv.config.json` — app configuration (repos, branches, agent settings, PR tokens)
  - `.ocv-state.json` — run results and branch review history
  - `.ocv.secrets.json` — PR authentication tokens (gitignored)
- Renderer auto-generates config form fields from config object shape — adding a key to config doesn't require renderer changes

## Important Files

| File | Role |
|------|------|
| `src/ocv.ts` | CLI entry point — arg parsing + subcommand dispatch |
| `src/lib/pipeline.ts` | Core orchestration — single-candidate lifecycle |
| `src/lib/git.ts` | Git operations — binary resolution, subprocess, worktree |
| `src/lib/agent.ts` | omp agent — prompt construction, subprocess, output streaming |
| `src/lib/pr.ts` | PR creation — Gitee/GitHub API, token resolution |
| `src/lib/report.ts` | Report generation — Markdown, PR body, INDEX |
| `app/main.js` | Electron main process — spawns CLI, IPC handlers |
| `app/preload.js` | Context bridge — exposes 6 methods + 2 event listeners |
| `app/renderer.js` | UI logic — dynamic form generation, status display |
| `ocv.config.json` | Runtime configuration |
| `package.json` | Scripts: `app` (electron), `ocv` (bun CLI), `postinstall`, `setup:electron` |

## Runtime & Tooling Preferences

| Aspect | Requirement |
|--------|-------------|
| **Runtime** | Bun (global install assumed) — runs `.ts` natively |
| **Package manager** | Bun (`bun.lock`) |
| **Electron** | `^44.4.2` (devDependency only) |
| **Build step** | None — Bun executes TypeScript directly |
| **Type checking** | None — no `tsconfig.json`, types are inline |
| **Linting** | None configured |
| **Git** | Required — heavy use of worktrees, branches, fetch, push |
| **External agent** | `omp` binary must be available (configurable path in `ocv.config.json`) |

## Testing & QA

**No test infrastructure exists.** No test files, no test framework, no test scripts, no coverage configuration.

When adding tests:
- Bun has built-in test runner (`bun test`) — natural fit for this project
- Test files would go in `src/__tests__/` or `src/lib/*.test.ts`
- Focus on: config parsing, branch filtering logic, findings parsing, PR URL construction
- Git operations and subprocess calls would need mocking

## PR Creation

Supports two platforms via config:
- **Gitee**: API v5, token from env var or `.ocv.secrets.json`
- **GitHub**: REST API, token from env var or `.ocv.secrets.json`

Platform is set per-repo in `ocv.config.json` `repos[].pr` field.