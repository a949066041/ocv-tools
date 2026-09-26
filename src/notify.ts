/** 机器人 webhook 通知：每个仓库跑完 POST 一条 JSON 摘要。失败只打日志，不阻塞其余仓库 */
import type { Config, IndexEntry } from "./types.js";

export interface RepoSummary {
  repo: string;
  branches: number;
  fixed: number;
  counts: Record<string, number>;
  prs: string[];
  errors: string[];
}

export function summarizeRepo(repo: string, all: IndexEntry[]): RepoSummary {
  const entries = all.filter((e) => e.repo === repo);
  const counts: Record<string, number> = {};
  for (const e of entries) for (const [k, v] of Object.entries(e.counts)) counts[k] = (counts[k] ?? 0) + v;
  return {
    repo,
    branches: entries.length,
    fixed: entries.reduce((n, e) => n + e.fixed, 0),
    counts,
    prs: entries.map((e) => e.prUrl).filter((p): p is string => !!p),
    errors: entries.map((e) => e.error).filter((e): e is string => !!e),
  };
}

/** payload 兼容企业微信/钉钉机器人(msgtype+text.content),同时带结构化字段供自定义机器人消费 */
export async function notifyRepo(cfg: Config, s: RepoSummary): Promise<void> {
  const url = cfg.notify.webhook.trim();
  if (!url) return;
  const lines = [
    `ocv 审查完成：${s.repo}`,
    `分支 ${s.branches} 个，修复 ${s.fixed} 处，critical ${s.counts.critical ?? 0} / high ${s.counts.high ?? 0} / medium ${s.counts.medium ?? 0} / low ${s.counts.low ?? 0}`,
    ...s.prs.map((p) => `PR: ${p}`),
    ...s.errors.map((e) => `失败: ${e}`),
  ];
  const content = lines.join("\n");
  const body = { msgtype: "text", text: { content }, ...s };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.log(`⚠️  webhook 通知失败: HTTP ${r.status} (${url})`);
    else console.log(`🔔 已通知机器人: ${s.repo}`);
  } catch (e) {
    console.log(`⚠️  webhook 通知失败: ${(e as Error).message}`);
  }
}
