/**
 * CLI 子命令实现：status / run / add。
 */
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { Config, PrKind, State, Candidate, IndexEntry } from "./types";
import { CONFIG_PATH, STATE_PATH, REPORT_DIR } from "./constants";
import { globToRe, die } from "./utils";
import { loadJson, saveJson } from "./config";
import { scanRepo } from "./scan";
import { processCandidate } from "./pipeline";
import { writeIndex } from "./report";

export function cmdStatus(cfg: Config) {
  const state = loadJson<State>(STATE_PATH, { branches: {} });
  const keys = Object.keys(state.branches);
  if (!keys.length) {
    console.log("还没有跑过任何分支。先 `ocv run --dry-run` 看范围。");
    return;
  }
  const rows = keys.map((k) => {
    const [repo, branch] = k.split("|");
    const b = state.branches[k];
    const c = b.counts ?? {};
    const total = Object.values(c).reduce((a, x) => a + x, 0);
    return `${repo}\t${branch}\t${total}\t${c.critical ?? 0}/${c.high ?? 0}\t${b.prUrl ?? b.error ?? "-"}\t${b.reviewedAt.slice(0, 19)}`;
  });
  console.log("仓库\t分支\t发现\tcrit/high\tPR或错误\t最近运行");
  console.log(rows.join("\n"));
  const latest = keys.map((k) => state.branches[k].report).filter((r): r is string => !!r).sort().pop();
  if (latest) console.log(`\n最新汇总: ${join(dirname(latest), "INDEX.md")}`);
}

export async function cmdRun(cfg: Config, args: { repo?: string; branch?: string; force: boolean; dryRun: boolean; keep: boolean; concurrency?: number }) {
  const state = loadJson<State>(STATE_PATH, { branches: {} });
  const repoFilter = args.repo ? globToRe(args.repo) : null;
  const branchFilter = args.branch ? globToRe(args.branch) : null;
  const repos = cfg.repos.filter((r) => r.enabled !== false && (!repoFilter || repoFilter.test(r.name)));
  if (!repos.length) die("没有匹配的仓库，先 `ocv add <path>`");

  const all: Candidate[] = [];
  for (const repo of repos) {
    const { candidates, skipped } = await scanRepo(cfg, state, repo, { force: args.force, branchFilter: branchFilter ?? undefined });
    console.log(`\n${repo.name}: ${candidates.length} 个分支待审${skipped.length ? `，跳过 ${skipped.length} 个` : ""}`);
    for (const s of skipped) console.log(`  - ${s}`);
    for (const c of candidates) console.log(`  ✓ ${c.branch}  ${c.commits} 个提交  ${c.mergeBase.slice(0, 8)}..${c.sha.slice(0, 8)}`);
    all.push(...candidates);
  }
  if (!all.length) {
    console.log("\n没有需要处理的分支。");
    return;
  }
  if (args.dryRun) {
    console.log(`\n(dry-run) 共 ${all.length} 个分支，未执行。`);
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const entries: IndexEntry[] = [];
  console.log(`\n开始审查 ${all.length} 个分支，并发 ${args.concurrency ?? cfg.concurrency}，日期 ${date}\n`);

  let cursor = 0;
  const worker = async () => {
    while (cursor < all.length) {
      const c = all[cursor++];
      const t0 = Date.now();
      console.log(`▶ ${c.repo.name}/${c.branch}`);
      const { state: st, fixed } = await processCandidate(cfg, c, args.keep);
      state.branches[`${c.repo.name}|${c.branch}`] = st;
      saveJson(STATE_PATH, state);
      console.log(`✔ ${c.repo.name}/${c.branch}  ${((Date.now() - t0) / 60000).toFixed(1)}min  ${st.prUrl || st.note || st.error || "无修复"}`);
      entries.push({ repo: c.repo.name, branch: c.branch, counts: st.counts ?? {}, fixed, prUrl: st.prUrl, report: st.report ?? "", error: st.error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency ?? cfg.concurrency, all.length) }, worker));
  writeIndex(date, entries);
  console.log(`\n汇总: ${join(REPORT_DIR, date, "INDEX.md")}`);
}

export function cmdAdd(cfg: Config, path: string, opts: { name?: string; base?: string; branches?: string; pr?: PrKind }) {
  const abs = resolve(path.replace(/^~/, process.env.HOME ?? "~"));
  if (!existsSync(join(abs, ".git"))) die(`${abs} 不是 git 仓库`);
  const name = opts.name ?? abs.split("/").pop()!;
  if (cfg.repos.some((r) => r.name === name)) die(`仓库 ${name} 已存在`);
  cfg.repos.push({ name, path: abs, base: opts.base, branches: opts.branches, pr: opts.pr, enabled: true });
  saveJson(CONFIG_PATH, cfg);
  console.log(`已添加 ${name} → ${abs}`);
}