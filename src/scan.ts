/** 分支扫描：筛选待审候选 */
import type { Candidate, Config, RepoCfg, State } from "./types.js";
import { globToRe } from "./config.js";
import { git, gitOrNull } from "./git.js";

export async function pickBase(cfg: Config, repo: RepoCfg): Promise<string> {
  const cands = repo.base ? [repo.base, ...cfg.baseCandidates.filter((b) => b !== repo.base)] : cfg.baseCandidates;
  for (const b of cands) {
    if (await gitOrNull(["rev-parse", "--verify", "--quiet", b], repo.path)) return b;
  }
  throw new Error(`${repo.name}: 找不到基线分支（试过 ${cands.join(", ")}），请在 config 里指定 base`);
}

/** 扫描远端分支，按时间倒序取前 maxBranches 个作为审查候选 */
export async function scanRepo(
  cfg: Config, state: State, repo: RepoCfg,
  opts: { force: boolean; branchFilter?: RegExp },
): Promise<{ candidates: Candidate[]; skipped: string[] }> {
  await git(["fetch", "origin", "--prune"], repo.path);
  const base = await pickBase(cfg, repo);
  const pattern = globToRe(repo.branches || cfg.branches);
  const maxBranches = repo.maxBranches ?? cfg.maxBranches;
  const cutoff = Date.now() - cfg.maxAgeDays * 86400_000;

  const raw = await git(["for-each-ref", "--format=%(refname:short) %(objectname) %(committerdate:unix)", "refs/remotes/origin/"], repo.path);
  const rows = raw.split("\n").filter(Boolean).map((l) => {
    const [ref, sha, ts] = l.split(" ");
    return { ref, sha, ts: Number(ts) * 1000 };
  });

  // 同步筛选：分支名匹配 + 时间 + sha 去重
  const skipped: string[] = [];
  const eligible = rows.flatMap(({ ref, sha, ts }) => {
    const branch = ref.replace(/^origin\//, "");
    if (branch === "HEAD" || !pattern.test(branch)) return [];
    if (opts.branchFilter && !opts.branchFilter.test(branch)) return [];
    if (ts < cutoff) { skipped.push(`${branch} (${cfg.maxAgeDays} 天无提交)`); return []; }
    if (!opts.force && state.branches[`${repo.name}|${branch}`]?.sha === sha) { skipped.push(`${branch} (与上次审查同一提交)`); return []; }
    return [{ ref, branch, sha, ts }];
  });

  // 异步筛选：merge-base 检查（需要 git 命令）
  const resolved = await Promise.all(eligible.map(async ({ ref, branch, sha, ts }) => {
    const mb = await gitOrNull(["merge-base", base, ref], repo.path);
    if (!mb) return { skip: `${branch} (与 ${base} 无共同祖先)`, ts: 0, candidate: null };
    if (mb === sha) return { skip: `${branch} (相对 ${base} 无新提交)`, ts: 0, candidate: null };
    const commits = Number(await git(["rev-list", "--count", `${mb}..${ref}`], repo.path));
    return { skip: null, ts, candidate: { repo, branch, sha, mergeBase: mb, commits } as Candidate };
  }));

  for (const r of resolved) if (r.skip) skipped.push(r.skip);
  const list = resolved.filter((r) => r.candidate).sort((a, b) => b.ts - a.ts).map((r) => r.candidate!);
  const overflow = list.splice(maxBranches).map((o) => `${o.branch} (超出 maxBranches=${maxBranches})`);
  return { candidates: list, skipped: [...skipped, ...overflow] };
}
