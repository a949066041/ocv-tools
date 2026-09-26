/**
 * 全局共享类型定义。零实现，零依赖。
 */

export type PrKind = "gitee" | "github" | "manual";
export type Severity = "critical" | "high" | "medium" | "low";

export interface RepoCfg {
  name: string;
  path: string;
  enabled?: boolean;
  base?: string;
  branches?: string;
  pr?: PrKind;
  maxBranches?: number;
}

export interface Config {
  git?: string;
  baseCandidates: string[];
  branches: string;
  maxAgeDays: number;
  maxBranches: number;
  maxFiles: number;
  concurrency: number;
  reportInRepo: string;
  agent: { bin: string; model?: string; timeoutMinutes: number; extraArgs?: string[] };
  pr: { giteeTokenEnv: string; githubTokenEnv: string };
  repos: RepoCfg[];
}

export const DEFAULT_CONFIG: Config = {
  baseCandidates: ["origin/master", "origin/main"],
  branches: "feature*,feat*",
  maxAgeDays: 14,
  maxBranches: 5,
  maxFiles: 40,
  concurrency: 2,
  reportInRepo: ".code-review",
  agent: { bin: "omp", model: "", timeoutMinutes: 40, extraArgs: [] },
  pr: { giteeTokenEnv: "GITEE_TOKEN", githubTokenEnv: "GITHUB_TOKEN" },
  repos: [],
};

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

export interface BranchState {
  sha: string;
  reviewedAt: string;
  fixBranch?: string;
  prUrl?: string;
  note?: string;
  counts?: Record<string, number>;
  report?: string;
  changedFiles?: number;
  commits?: number;
  error?: string;
}

export interface State { branches: Record<string, BranchState> }

export interface Candidate {
  repo: RepoCfg;
  branch: string;
  sha: string;
  mergeBase: string;
  commits: number;
  ts: number;
}

export interface IndexEntry {
  repo: string;
  branch: string;
  counts: Record<string, number>;
  fixed: number;
  prUrl?: string;
  report: string;
  error?: string;
}