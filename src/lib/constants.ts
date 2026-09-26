import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
export const CONFIG_PATH = join(ROOT, "ocv.config.json");
export const STATE_PATH = join(ROOT, ".ocv-state.json");
export const WT_DIR = join(ROOT, ".wt");
export const RUN_DIR = join(ROOT, ".run");
export const REPORT_DIR = join(ROOT, "reports");

export const USAGE = `ocv — 夜间 feature 分支 OCR 审查 + 自动修复 + 提 PR

  ocv add <path> [--name x] [--base origin/master] [--branches "feature*,feat*"] [--pr gitee|github|manual]
  ocv status
  ocv config                                   # 打印有效配置 + 各路径（JSON，GUI 用）
  ocv run [--repo <glob>] [--branch <glob>] [--force] [--dry-run] [--keep] [--concurrency N]

配置: ${CONFIG_PATH}
状态: ${STATE_PATH}
报告: ${REPORT_DIR}/<日期>/INDEX.md`;