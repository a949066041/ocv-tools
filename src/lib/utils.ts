/**
 * 通用工具函数。零副作用，不碰 IO。
 */
import type { Severity } from "./types";

export function isSeverity(v: unknown): v is Severity {
  return v === "critical" || v === "high" || v === "medium" || v === "low";
}

export function die(msg: string): never {
  console.error(`ocv: ${msg}`);
  process.exit(1);
}

/** glob 逗号列表 → regex，`*` 跨 `/` 匹配（与 git refspec 语义一致） */
export function globToRe(globs: string): RegExp {
  const parts = globs.split(",").map((g) => g.trim()).filter(Boolean)
    .map((g) => g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  return new RegExp(`^(?:${parts.join("|")})$`);
}

export const slugOfRepoBranch = (repoName: string, branch: string) =>
  `${repoName}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;

export const escapeCell = (s: string) =>
  s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();