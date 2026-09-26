/** ocv 共享类型。配置类型唯一来源是 schema.ts;路径常量在 paths.ts(本文件保持无 node 依赖,renderer 可共享)。 */
import type { RepoCfg, Severity } from "./schema.js";

export type { Config, RepoCfg, PrKind, Severity, GuiConfig } from "./schema.js";
export { isSeverity } from "./schema.js";

export interface Finding {
  path: string;
  content: string;
  start_line?: number;
  end_line?: number;
  category?: string;
  severity: Severity;
  fixed?: boolean;
  fix_summary?: string;
}

export interface Coverage {
  total_files?: number;
  reviewed_files?: number;
  skipped_files?: number;
  skipped?: { path: string; reason: string }[];
}

/** 每个分支的审查持久化状态,写入 .ocv-state.json,下次 run 时跳过未变分支 */
export interface BranchState {
  sha: string; // 审查时的提交 sha,同 sha 不重复审查
  reviewedAt: string;
  fixBranch?: string; // 推到远端的修复分支名
  prUrl?: string; // 创建的 PR 链接
  note?: string; // 无 PR 时的原因说明
  counts?: Record<string, number>;
  report?: string; // 本地报告路径
  changedFiles?: number;
  commits?: number;
  error?: string;
}

export interface State { branches: Record<string, BranchState> }

export interface Candidate {
  repo: RepoCfg;
  branch: string;
  sha: string;
  mergeBase: string; // 与基线分支的共同祖先,审查 diff 的起点
  commits: number; // mergeBase..branch 的提交数
}

export interface IndexEntry {
  repo: string;
  branch: string;
  counts: Record<string, number>;
  fixed: number;
  report: string;
  prUrl?: string;
  error?: string;
}

export interface RunFacts {
  base: string;
  fixBranch: string;
  findings: Finding[];
  coverage: Coverage | null;
  changedFiles: number;
  logPath: string;
  prUrl?: string;
  note?: string;
  repoReport?: string;
}

export interface ExecResult { code: number; out: string; err: string }
