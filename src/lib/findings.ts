/**
 * findings.json 解析。
 */
import type { Finding, Coverage } from "./types";
import { loadJson } from "./config";
import { isSeverity } from "./utils";

export function readFindings(path: string): { findings: Finding[]; coverage: Coverage | null } {
  const raw = loadJson<unknown>(path, null);
  if (typeof raw !== "object" || raw === null) return { findings: [], coverage: null };

  const list: unknown[] = "findings" in raw && Array.isArray(raw.findings) ? raw.findings : [];
  const findings: Finding[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    if (!("path" in item) || typeof item.path !== "string") continue;
    if (!("content" in item) || typeof item.content !== "string") continue;
    findings.push({
      path: item.path,
      content: item.content,
      start_line: "start_line" in item && typeof item.start_line === "number" ? item.start_line : undefined,
      end_line: "end_line" in item && typeof item.end_line === "number" ? item.end_line : undefined,
      category: "category" in item && typeof item.category === "string" ? item.category : undefined,
      severity: "severity" in item && isSeverity(item.severity) ? item.severity : "medium",
      fixed: "fixed" in item && item.fixed === true,
      fix_summary: "fix_summary" in item && typeof item.fix_summary === "string" ? item.fix_summary : undefined,
    });
  }

  if (!("coverage" in raw) || typeof raw.coverage !== "object" || raw.coverage === null) return { findings, coverage: null };
  const cov = raw.coverage;
  const skipped: unknown[] = "skipped" in cov && Array.isArray(cov.skipped) ? cov.skipped : [];
  return {
    findings,
    coverage: {
      total_files: "total_files" in cov && typeof cov.total_files === "number" ? cov.total_files : undefined,
      reviewed_files: "reviewed_files" in cov && typeof cov.reviewed_files === "number" ? cov.reviewed_files : undefined,
      skipped_files: "skipped_files" in cov && typeof cov.skipped_files === "number" ? cov.skipped_files : undefined,
      skipped: skipped.flatMap((s) => (typeof s === "object" && s !== null && "path" in s && typeof s.path === "string"
        ? [{ path: s.path, reason: "reason" in s && typeof s.reason === "string" ? s.reason : "" }]
        : [])),
    },
  };
}

export function countBy(findings: Finding[]): Record<string, number> {
  const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
  return c;
}