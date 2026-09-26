#!/usr/bin/env bun
/**
 * ocv - 夜间批量审查 feature* 分支,自动修 critical/high,向 feature 分支提 PR。
 *
 * 命令:
 *   ocv add <path> [--name x] [--base origin/master] [--branches "feature*,feat*"] [--pr gitee|github|manual]
 *   ocv remove <name>
 *   ocv status
 *   ocv config            # 打印有效配置 + 各路径(JSON,GUI 用)
 *   ocv save-config       # 从 stdin 读 JSON,zod 校验后落盘(GUI 保存走这条,防写坏配置)
 *   ocv run [--repo <glob>] [--branch <glob>] [--force] [--dry-run] [--keep] [--concurrency N]
 */
import { parseArgs } from "node:util";
import { CONFIG_PATH, STATE_PATH, REPORT_DIR, ROOT, RUN_DIR, WT_DIR } from "./paths.js";
import { die, loadConfig, saveJson } from "./config.js";
import { configSchema, prKindSchema, assertTokenEnvNames } from "./schema.js";
import { applyBotIdentity, resolveGit } from "./git.js";
import { cmdStatus, cmdRun, cmdAdd, cmdRemove } from "./commands.js";

const USAGE = `ocv - 夜间 feature 分支 OCR 审查 + 自动修复 + 提 PR

  ocv add <path> [--name x] [--base origin/master] [--branches "feature*,feat*"] [--pr gitee|github|manual]
  ocv remove <name>
  ocv status
  ocv config            # 打印有效配置 + 各路径(JSON,GUI 用)
  ocv save-config       # 从 stdin 读 JSON 校验后保存
  ocv run [--repo <glob>] [--branch <glob>] [--force] [--dry-run] [--keep] [--concurrency N]

配置: ${CONFIG_PATH}
状态: ${STATE_PATH}
报告: ${REPORT_DIR}/<日期>/INDEX.md`;

async function main() {
  const { values: flags, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      name: { type: "string" },
      base: { type: "string" },
      branches: { type: "string" },
      pr: { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      concurrency: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const [cmd, ...rest] = positionals;
  if (!cmd || cmd === "help" || flags.help) {
    console.log(USAGE);
    return;
  }

  // save-config 不依赖现有配置：GUI 首次保存时配置可能还不存在/已写坏
  if (cmd === "save-config") {
    const raw = await Bun.stdin.text();
    const result = configSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      die(`配置校验失败:\n${result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    }
    try {
      assertTokenEnvNames(result.data);
    } catch (e) {
      die((e as Error).message);
    }
    saveJson(CONFIG_PATH, result.data);
    console.log(`已保存 → ${CONFIG_PATH}`);
    return;
  }
  const cfg = loadConfig();
  resolveGit(cfg);
  applyBotIdentity(cfg);

  if (cmd === "add") {
    if (!rest[0]) die("用法: ocv add <path>");
    const prParsed = prKindSchema.safeParse(flags.pr);
    if (flags.pr !== undefined && !prParsed.success) die("--pr 只接受 gitee|github|manual");
    cmdAdd(cfg, rest[0], {
      name: flags.name,
      base: flags.base,
      branches: flags.branches,
      pr: flags.pr === undefined ? undefined : prParsed.data,
    });
    return;
  }
  if (cmd === "remove") {
    if (!rest[0]) die("用法: ocv remove <name>");
    cmdRemove(cfg, rest[0]);
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
    const concurrency = flags.concurrency === undefined ? undefined : Number(flags.concurrency);
    if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) die("--concurrency 需要正整数");
    await cmdRun(cfg, {
      repo: flags.repo,
      branch: flags.branch,
      force: flags.force,
      dryRun: flags["dry-run"],
      keep: flags.keep,
      concurrency,
    });
    return;
  }
  die(`未知命令: ${cmd}(ocv help)`);
}

main().catch((e) => die((e as Error).message));
