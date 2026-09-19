#!/usr/bin/env bun
/**
 * ocv — 夜间批量审查 feature* 分支，自动修 critical/high，向 feature 分支提 PR。
 *
 * 零依赖、单文件。命令：
 *   ocv add <path> [--name x] [--base origin/master] [--branches "feature*,feat*"] [--pr gitee|github|manual]
 *   ocv status
 *   ocv run [--repo <glob>] [--branch <glob>] [--force] [--dry-run] [--keep] [--concurrency N]
 *
 * 分工：ocr 只做确定性的活（选文件 + 解析规则），审查和修复由无头 agent 干。
 * 这样不用给 ocr 配 LLM provider，同一份智能顺带把修复也做了。
 */
import type { PrKind } from "./lib/types";
import { ROOT, CONFIG_PATH, STATE_PATH, REPORT_DIR, RUN_DIR, WT_DIR, USAGE } from "./lib/constants";
import { die } from "./lib/utils";
import { loadConfig } from "./lib/config";
import { resolveGit } from "./lib/git";
import { cmdStatus, cmdRun, cmdAdd } from "./lib/commands";

function parseFlags(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { _.push(a); continue; }
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith("-")) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { _, flags };
}

async function main() {
  const { _, flags } = parseFlags(process.argv.slice(2));
  const [cmd, ...rest] = _;
  if (!cmd || cmd === "help" || flags.help) {
    console.log(USAGE);
    return;
  }

  const cfg = loadConfig();
  resolveGit(cfg);

  if (cmd === "add") {
    if (!rest[0]) die("用法: ocv add <path>");
    cmdAdd(cfg, rest[0], {
      name: typeof flags.name === "string" ? flags.name : undefined,
      base: typeof flags.base === "string" ? flags.base : undefined,
      branches: typeof flags.branches === "string" ? flags.branches : undefined,
      pr: typeof flags.pr === "string" ? (flags.pr as PrKind) : undefined,
    });
    return;
  }
  if (cmd === "config") {
    console.log(JSON.stringify({
      ...cfg,
      _paths: { root: ROOT, config: CONFIG_PATH, state: STATE_PATH, reports: REPORT_DIR, run: RUN_DIR, worktrees: WT_DIR },
    }, null, 2));
    return;
  }
  if (cmd === "status") {
    cmdStatus(cfg);
    return;
  }
  if (cmd === "run") {
    await cmdRun(cfg, {
      repo: typeof flags.repo === "string" ? flags.repo : undefined,
      branch: typeof flags.branch === "string" ? flags.branch : undefined,
      force: !!flags.force,
      dryRun: !!flags["dry-run"],
      keep: !!flags.keep,
      concurrency: typeof flags.concurrency === "string" ? Number(flags.concurrency) : undefined,
    });
    return;
  }
  die(`未知命令: ${cmd}（ocv help）`);
}

await main();