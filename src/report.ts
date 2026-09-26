/** findings 解析 + Markdown 报告生成 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Candidate, Coverage, Finding, IndexEntry, RunFacts } from "./types.js";
import { REPORT_DIR } from "./paths.js";
import { loadJson } from "./config.js";
import { severitySchema } from "./schema.js";
import { slugOfRepoBranch } from "./agent.js";

/** agent 写的 findings.json 是不可信外部输入：逐字段容错，坏条目丢弃而不是整份报错 */
const findingSchema = z.object({
  path: z.string(),
  content: z.string(),
  start_line: z.number().optional().catch(undefined),
  end_line: z.number().optional().catch(undefined),
  category: z.string().optional().catch(undefined),
  severity: severitySchema.catch("medium"),
  fixed: z.boolean().catch(false),
  fix_summary: z.string().optional().catch(undefined),
});

const coverageSchema = z.object({
  total_files: z.number().optional().catch(undefined),
  reviewed_files: z.number().optional().catch(undefined),
  skipped_files: z.number().optional().catch(undefined),
  skipped: z.array(z.object({ path: z.string(), reason: z.string().catch("") }).nullable().catch(null)).catch([]),
});

const findingsFileSchema = z.object({
  findings: z.array(findingSchema.nullable().catch(null)).catch([]),
  coverage: coverageSchema.nullable().catch(null).optional(),
});

export function readFindings(path: string): { findings: Finding[]; coverage: Coverage | null } {
  const raw = loadJson<unknown>(path, null);
  const parsed = findingsFileSchema.safeParse(raw);
  if (!parsed.success) return { findings: [], coverage: null };
  const cov = parsed.data.coverage;
  return {
    findings: parsed.data.findings.flatMap((f) => (f === null ? [] : [f])),
    coverage: cov ? { ...cov, skipped: cov.skipped.filter((s): s is { path: string; reason: string } => s !== null) } : null,
  };
}

export function countBy(findings: Finding[]): Record<string, number> {
  return findings.reduce<Record<string, number>>(
    (acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }),
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

/** withFix=true 时多一列「处理」，给已修复的 finding 写 fix_summary */
function findingTable(findings: Finding[], withFix: boolean): string {
  if (!findings.length) return "_无_\n";
  const head = withFix
    ? "| 文件 | 行 | 级别 | 问题 | 处理 |\n|---|---|---|---|---|\n"
    : "| 文件 | 行 | 级别 | 问题 |\n|---|---|---|---|\n";
  const rows = findings.map((f) => {
    const loc = f.start_line ? `${f.start_line}${f.end_line && f.end_line !== f.start_line ? `-${f.end_line}` : ""}` : "-";
    const cells = `| \`${f.path}\` | ${loc} | ${f.severity} | ${escapeCell(f.content)} |`;
    return withFix ? `${cells} ${escapeCell(f.fix_summary ?? "")} |` : cells;
  });
  return head + rows.join("\n") + "\n";
}

/** forRepo=true 时生成的是提交进仓库、给同事看的那份：不带本地路径，带复查命令 */
export function buildReport(c: Candidate, f: RunFacts, forRepo = false): string {
  const fixed = f.findings.filter((x) => x.fixed);
  const rest = f.findings.filter((x) => !x.fixed);
  const counts = countBy(f.findings);
  const intro = forRepo
    ? `> ocv 夜间自动审查的产物，随修复分支一起提交。critical/high 已自动修复，其余**只需你判断是否需要处理**。
> 复查：\`ocr delegate preview --from ${f.base} --to ${c.sha}\`，逐文件 \`git diff ${c.mergeBase}..${c.sha} -- <path>\`。

`
    : "";
  const prLine = forRepo ? "" : `- PR: ${f.prUrl ? `[${f.prUrl}](${f.prUrl})` : "_未创建_"}\n`;
  const noteLine = forRepo || !f.note ? "" : `- 备注: ${f.note}\n`;
  const coverageLine = f.coverage
    ? `- 覆盖率: 审查 ${f.coverage.reviewed_files ?? "?"} / ${f.coverage.total_files ?? "?"} 个文件，跳过 ${f.coverage.skipped_files ?? 0} 个\n`
    : "";
  const skipped = f.coverage?.skipped?.length
    ? `\n## 跳过未审的文件\n\n${f.coverage.skipped.map((s) => `- \`${s.path}\`: ${s.reason}`).join("\n")}\n`
    : "";
  const tail = forRepo
    ? `## 说明

本文件只是一份审查清单，不参与业务逻辑；合并后可按需删除，或在配置里把 \`reportInRepo\` 置空以关闭。
`
    : `## 运行日志

\`${f.logPath}\`
`;
  return `${intro}# ${c.repo.name} / ${c.branch}

- 对比: \`${f.base}...${c.branch}\`（merge-base \`${c.mergeBase.slice(0, 8)}\`，新增 ${c.commits} 个提交）
- 修复分支: \`${f.fixBranch}\`（改动文件 ${f.changedFiles} 个）
${prLine}${noteLine}- 发现: critical ${counts.critical} / high ${counts.high} / medium ${counts.medium} / low ${counts.low}，已自动修复 ${fixed.length} 条
${coverageLine}
## 已自动修复（critical / high）

${findingTable(fixed, true)}
## 需要人工处理

${findingTable(rest, false)}${skipped}
${tail}`;
}

export function buildPrBody(c: Candidate, f: RunFacts): string {
  const fixed = f.findings.filter((x) => x.fixed);
  const rest = f.findings.filter((x) => !x.fixed);
  const counts = countBy(f.findings);
  return `## 夜间自动代码审查

对 \`${f.base}...${c.branch}\`（merge-base \`${c.mergeBase.slice(0, 8)}\`，${c.commits} 个提交）做了自动审查。

- 发现：critical ${counts.critical} / high ${counts.high} / medium ${counts.medium} / low ${counts.low}
- 本 PR 已自动修复 critical/high 共 ${fixed.length} 条，另改动 ${f.changedFiles} 个文件

### 已自动修复

${findingTable(fixed, true)}
### 需要人工处理（本次未改动）

${findingTable(rest, false)}
合并本 PR 即把自动修复带入 \`${c.branch}\`；上表「需要人工处理」的问题请自行修复${f.repoReport ? `。

### 完整清单

全部发现（含 medium/low）已随本分支提交到 \`${f.repoReport}\`，不需要本地工具即可查看` : ""}。

---
由 ocv 自动生成。本地留档：\`reports/<日期>/${slugOfRepoBranch(c.repo.name, c.branch)}.md\``;
}

export function writeIndex(date: string, entries: IndexEntry[], dir = REPORT_DIR) {
  const out = join(dir, date);
  mkdirSync(out, { recursive: true });
  const head = "| 仓库 | 分支 | critical | high | medium | low | 已修 | PR | 报告 |\n|---|---|---|---|---|---|---|---|---|\n";
  const rows = entries.map((e) => {
    const rel = e.report.replace(`${out}/`, "");
    const pr = e.prUrl ? `[链接](${e.prUrl})` : (e.error ? `失败: ${escapeCell(e.error)}` : "-");
    return `| ${e.repo} | ${e.branch} | ${e.counts.critical ?? 0} | ${e.counts.high ?? 0} | ${e.counts.medium ?? 0} | ${e.counts.low ?? 0} | ${e.fixed} | ${pr} | [${rel}](${encodeURIComponent(rel)}) |`;
  });
  writeFileSync(join(out, "INDEX.md"), `# 夜间代码审查 ${date}\n\n${head}${rows.join("\n")}\n`);
}
