/** CLI 子命令实现 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Candidate, Config, IndexEntry, PrKind, State } from "./types.js";
import { CONFIG_PATH, STATE_PATH, REPORT_DIR } from "./paths.js";
import { die, globToRe, loadJson, saveJson } from "./config.js";
import { scanRepo } from "./scan.js";
import { processCandidate } from "./pipeline.js";
import { writeIndex } from "./report.js";
import { notifyRepo, summarizeRepo } from "./notify.js";
import { sh } from "./git.js";

export function cmdStatus(cfg: Config) {
  const state = loadJson<State>(STATE_PATH, { branches: {} });
  const keys = Object.keys(state.branches);
  if (!keys.length) {
    console.log("还没有跑过任何分支。先 `ocv run --dry-run` 看范围。");
    return;
  }
  console.log("仓库\t分支\t发现\tcrit/high\tPR或错误\t最近运行");
  for (const k of keys) {
    const [repo, branch] = k.split("|");
    const b = state.branches[k];
    const c = b.counts ?? {};
    const total = Object.values(c).reduce((a, x) => a + x, 0);
    console.log(`${repo}\t${branch}\t${total}\t${c.critical ?? 0}/${c.high ?? 0}\t${b.prUrl ?? b.error ?? "-"}\t${b.reviewedAt.slice(0, 19)}`);
  }
  const latest = keys.map((k) => state.branches[k].report).filter((r): r is string => !!r).sort().pop();
  if (latest) console.log(`\n最新汇总: ${join(dirname(latest), "INDEX.md")}`);
}

/** run 依赖外部 ocr 二进制；开扫前先确认在，免得每个分支都失败一遍 */
async function preflightOcr() {
  const v = await sh("ocr", ["--version"]);
  if (v.code !== 0) die(`找不到 ocr 命令（${v.err || "not found"}）。先安装 open-code-review 并确认在 PATH 里。`);
}

/** 扫描 → 筛选 → 并发审查 → 写汇总 INDEX.md */
export async function cmdRun(cfg: Config, args: { repo?: string; branch?: string; force: boolean; dryRun: boolean; keep: boolean; concurrency?: number }) {
  await preflightOcr();
  const state = loadJson<State>(STATE_PATH, { branches: {} });
  const repoFilter = args.repo ? globToRe(args.repo) : null;
  const branchFilter = args.branch ? globToRe(args.branch) : null;
  const repos = cfg.repos.filter((r) => r.enabled !== false && (!repoFilter || repoFilter.test(r.name)));
  if (!repos.length) die("没有匹配的仓库，先 `ocv add <path>`");

  // 逐仓库扫描，汇总所有候选分支
  const all: Candidate[] = [];
  for (const repo of repos) {
    const { candidates, skipped } = await scanRepo(cfg, state, repo, { force: args.force, branchFilter: branchFilter ?? undefined });
    console.log(`\n${repo.name}: ${candidates.length} 个分支待审${skipped.length ? `，跳过 ${skipped.length} 个` : ""}`);
    skipped.forEach((s) => console.log(`  - ${s}`));
    candidates.forEach((c) => console.log(`  ✓ ${c.branch}  ${c.commits} 个提交  ${c.mergeBase.slice(0, 8)}..${c.sha.slice(0, 8)}`));
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

  // 并发 worker：各 worker 从队列取任务，直到全部完成
  const concurrency = Math.min(args.concurrency ?? cfg.concurrency, all.length);
  const queue = all.values();
  const worker = async () => {
    for (const c of queue) {
      const t0 = Date.now();
      console.log(`▶ ${c.repo.name}/${c.branch}`);
      const { state: st, fixed } = await processCandidate(cfg, c, { keep: args.keep, date });
      state.branches[`${c.repo.name}|${c.branch}`] = st;
      saveJson(STATE_PATH, state);
      console.log(`✔ ${c.repo.name}/${c.branch}  ${((Date.now() - t0) / 60000).toFixed(1)}min  ${st.prUrl || st.note || st.error || "无修复"}`);
      entries.push({ repo: c.repo.name, branch: c.branch, counts: st.counts ?? {}, fixed, prUrl: st.prUrl, report: st.report ?? "", error: st.error });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeIndex(date, entries);
  console.log(`\n汇总: ${join(REPORT_DIR, date, "INDEX.md")}`);

  // 逐仓库通知机器人:跑完一个发一个,0 候选也发(夜间值守需要"今晚没事"的信号)
  for (const repo of repos) {
    await notifyRepo(cfg, summarizeRepo(repo.name, entries));
  }
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

export function cmdRemove(cfg: Config, name: string) {
  const before = cfg.repos.length;
  cfg.repos = cfg.repos.filter((r) => r.name !== name);
  if (cfg.repos.length === before) die(`仓库 ${name} 不存在`);
  saveJson(CONFIG_PATH, cfg);
  console.log(`已移除 ${name}`);
}
