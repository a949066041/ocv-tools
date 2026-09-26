/**
 * 仓库扫描：发现符合条件的 feature 分支。
 */
import type { Config, RepoCfg, State, Candidate } from "./types";
import { git, gitOrNull } from "./git";
import { globToRe, die } from "./utils";

export async function pickBase(cfg: Config, repo: RepoCfg): Promise<string> {
  const cands = repo.base ? [repo.base, ...cfg.baseCandidates.filter((b) => b !== repo.base)] : cfg.baseCandidates;
  for (const b of cands) {
    if (await gitOrNull(["rev-parse", "--verify", "--quiet", b], repo.path)) return b;
  }
  die(`${repo.name}: 找不到基线分支（试过 ${cands.join(", ")}），请在 config 里指定 base`);
}

export async function scanRepo(
  cfg: Config, state: State, repo: RepoCfg,
  opts: { force: boolean; branchFilter?: RegExp },
): Promise<{ candidates: Candidate[]; skipped: string[] }> {
  const skipped: string[] = [];
  await git(["fetch", "origin", "--prune"], repo.path);
  const base = await pickBase(cfg, repo);
  const pattern = globToRe(repo.branches || cfg.branches);
  const maxBranches = repo.maxBranches ?? cfg.maxBranches;
  const cutoff = Date.now() - cfg.maxAgeDays * 86400_000;

  const raw = await git(
    ["for-each-ref", "--format=%(refname:short) %(objectname) %(committerdate:unix)", "refs/remotes/origin/"],
    repo.path,
  );
  const rows = raw.split("\n").filter(Boolean).map((l) => {
    const [ref, sha, ts] = l.split(" ");
    return { ref, sha, ts: Number(ts) * 1000 };
  });

  const list: Candidate[] = [];
  for (const { ref, sha, ts } of rows) {
    const branch = ref.replace(/^origin\//, "");
    if (branch === "HEAD" || !pattern.test(branch)) continue;
    if (opts.branchFilter && !opts.branchFilter.test(branch)) continue;
    if (ts < cutoff) { skipped.push(`${branch} (${cfg.maxAgeDays} 天无提交)`); continue; }
    if (!opts.force && state.branches[`${repo.name}|${branch}`]?.sha === sha) { skipped.push(`${branch} (与上次审查同一提交)`); continue; }
    const mb = await gitOrNull(["merge-base", base, ref], repo.path);
    if (!mb) { skipped.push(`${branch} (与 ${base} 无共同祖先)`); continue; }
    if (mb === sha) { skipped.push(`${branch} (相对 ${base} 无新提交)`); continue; }
    const commits = Number(await git(["rev-list", "--count", `${mb}..${ref}`], repo.path));
    list.push({ repo, branch, sha, mergeBase: mb, commits, ts });
  }
  list.sort((a, b) => b.ts - a.ts);
  for (const o of list.splice(maxBranches)) skipped.push(`${o.branch} (超出 maxBranches=${maxBranches})`);
  return { candidates: list, skipped };
}