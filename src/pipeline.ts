/** 单分支审查流水线：preview → worktree → agent → 收结果 → 报告 → 推送 + PR */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BranchState, Candidate, Config, Coverage, Finding, RunFacts } from "./types.js";
import { WT_DIR, RUN_DIR, REPORT_DIR } from "./paths.js";
import { sh, git, gitOrNull, GIT } from "./git.js";
import { parseRemote, prKindFor, createPr, type PrResult } from "./pr.js";
import { pickBase } from "./scan.js";
import { slugOfRepoBranch, buildPrompt, runAgent } from "./agent.js";
import { readFindings, countBy, buildReport, buildPrBody } from "./report.js";

const previewSchema = z.object({ reviewable_count: z.number().catch(0) }).catch({ reviewable_count: 0 });

interface Collected {
  findings: Finding[];
  coverage: Coverage | null;
  codeChanged: string[];
}

/** agent 跑完后收结果；agent 改了没提交时兜底：只提交 findings 里标了 fixed 的路径，其余脏文件丢弃 */
async function collectResults(wt: string, findingsPath: string, sha: string): Promise<Collected> {
  const { findings, coverage } = readFindings(findingsPath);
  const dirty = ((await gitOrNull(["status", "--porcelain"], wt)) ?? "").split("\n").filter(Boolean);
  if (dirty.length) {
    const fixPaths = findings.filter((f) => f.fixed).map((f) => f.path);
    if (fixPaths.length) {
      await sh(GIT, ["add", "--", ...fixPaths], { cwd: wt });
      await sh(GIT, ["commit", "-m", "fix(review): 夜间自动修复 critical/high"], { cwd: wt });
    }
    await sh(GIT, ["checkout", "--", "."], { cwd: wt });
    await sh(GIT, ["clean", "-fd"], { cwd: wt });
  }
  const codeChanged = ((await gitOrNull(["diff", "--name-only", `${sha}..HEAD`], wt)) ?? "").split("\n").filter(Boolean);
  return { findings, coverage, codeChanged };
}

/** 全部发现（含 medium/low）写成报告提交进分支：不看本地目录的同事在对比/PR 里也能看到 */
async function commitRepoReport(cfg: Config, c: Candidate, wt: string, facts: Omit<RunFacts, "repoReport">): Promise<string> {
  if (!cfg.reportInRepo || !facts.findings.length) return "";
  const slug = slugOfRepoBranch(c.repo.name, c.branch);
  const rel = `${cfg.reportInRepo.replace(/\/+$/, "")}/${c.branch.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`;
  const abs = join(wt, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buildReport(c, facts, true));
  await sh(GIT, ["add", "--", rel], { cwd: wt });
  const counts = countBy(facts.findings);
  const commit = await sh(GIT, ["commit", "-m",
    `chore(review): 夜间审查发现 ${counts.critical} critical / ${counts.high} high / ${counts.medium} medium / ${counts.low} low`], { cwd: wt });
  if (commit.code !== 0) {
    rmSync(abs, { force: true });
    console.log(`  ⚠️ ${slug} 审查报告提交失败（${commit.err}），只在本地留档`);
    return "";
  }
  console.log(`  📄 ${slug} 审查报告已提交到分支: ${rel}`);
  return rel;
}

/** 推修复分支 + 建 PR；force-with-lease 防止覆盖别人同期推的同名分支 */
async function pushAndPr(cfg: Config, c: Candidate, wt: string, fixBranch: string, facts: RunFacts): Promise<PrResult> {
  const push = await sh(GIT, ["push", "--force-with-lease", "-u", "origin", `${fixBranch}:${fixBranch}`], { cwd: wt });
  if (push.code !== 0) throw new Error(`git push 失败: ${push.err}`);
  const remote = parseRemote(await git(["remote", "get-url", "origin"], c.repo.path));
  if (!remote) throw new Error("无法解析 origin URL");
  const fixedN = facts.findings.filter((f) => f.fixed).length;
  return createPr(prKindFor(remote.host, c.repo), remote, cfg, fixBranch, c.branch,
    fixedN
      ? `[夜间审查] ${c.repo.name}/${c.branch}：自动修复 ${fixedN} 条，另有 ${facts.findings.length - fixedN} 条待人工判断`
      : `[夜间审查] ${c.repo.name}/${c.branch}：${facts.findings.length} 条发现（未自动修改代码）`,
    buildPrBody(c, facts));
}

/** date 由 cmdRun 统一传入，保证同一次 run 的所有报告落在同一目录（跨午夜不错位） */
export async function processCandidate(cfg: Config, c: Candidate, opts: { keep: boolean; date: string }): Promise<{ state: BranchState; fixed: number }> {
  const slug = slugOfRepoBranch(c.repo.name, c.branch);
  const wt = join(WT_DIR, slug);
  const runDir = join(RUN_DIR, slug);
  const fixBranch = `ocr-review/${c.branch.replace(/[^A-Za-z0-9._-]+/g, "-")}-${opts.date}-${c.sha.slice(0, 7)}`;
  const logPath = join(runDir, "log.txt");
  const findingsPath = join(runDir, "findings.json");
  const base = await pickBase(cfg, c.repo);
  const reportPath = join(REPORT_DIR, opts.date, `${slug}.md`);

  mkdirSync(runDir, { recursive: true });
  mkdirSync(WT_DIR, { recursive: true });
  rmSync(findingsPath, { force: true });

  const state: BranchState = { sha: c.sha, reviewedAt: new Date().toISOString(), fixBranch, commits: c.commits, counts: {} };

  try {
    // 1) 先零成本预筛：改动只剩二进制/lock 之类的直接跳过，不烧 LLM
    const preview = await sh("ocr", ["delegate", "preview", "--repo", c.repo.path, "--from", c.mergeBase, "--to", c.sha, "--format", "json"]);
    if (preview.code !== 0) throw new Error(`ocr delegate preview 失败: ${preview.err || preview.out}`);
    const parsed: unknown = JSON.parse(preview.out.slice(preview.out.indexOf("{")));
    if (typeof parsed !== "object" || parsed === null) throw new Error("ocr delegate preview 返回非 JSON");
    writeFileSync(join(runDir, "preview.json"), JSON.stringify(parsed, null, 2));
    state.changedFiles = previewSchema.parse(parsed).reviewable_count;
    if (!state.changedFiles) return { state: { ...state, error: "无可审文件" }, fixed: 0 };
    if (state.changedFiles > cfg.maxFiles) return { state: { ...state, error: `改动 ${state.changedFiles} 个文件，超过 maxFiles=${cfg.maxFiles}，留给人工审查` }, fixed: 0 };

    // 2) worktree + 修复分支
    rmSync(wt, { recursive: true, force: true });
    await sh(GIT, ["worktree", "prune"], { cwd: c.repo.path });
    await sh(GIT, ["branch", "-D", fixBranch], { cwd: c.repo.path });
    const add = await sh(GIT, ["worktree", "add", "-b", fixBranch, wt, c.sha], { cwd: c.repo.path });
    if (add.code !== 0) throw new Error(`git worktree add 失败: ${add.err}`);
    // worktree 继承主仓库的 hooks（如 husky），但没有 node_modules 会失败，禁用只影响这个 worktree
    await sh(GIT, ["config", "core.hooksPath", "/dev/null"], { cwd: wt });

    // 3) 无头 agent：审查 + 修 critical/high + commit
    const agentCode = await runAgent(cfg, buildPrompt(c, base, fixBranch, runDir), wt, runDir, logPath, slug);

    // 4) 收结果
    const { findings, coverage, codeChanged } = await collectResults(wt, findingsPath, c.sha);
    state.counts = countBy(findings);

    // 5) 报告提交进分支，再推 + 提 PR
    const facts: RunFacts = { base, fixBranch, findings, coverage, changedFiles: codeChanged.length, logPath };
    facts.repoReport = await commitRepoReport(cfg, c, wt, facts);
    const changed = ((await gitOrNull(["diff", "--name-only", `${c.sha}..HEAD`], wt)) ?? "").split("\n").filter(Boolean);
    const pr = changed.length
      ? await pushAndPr(cfg, c, wt, fixBranch, facts)
      : findings.length
        ? { url: "", note: "本次没有可自动修复的 critical/high，未创建 PR（问题已写进报告）" } satisfies PrResult
        : { url: "" } satisfies PrResult;
    if (pr.note) state.note = pr.note;
    facts.prUrl = pr.url;
    facts.note = pr.note;

    const report = buildReport(c, facts);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report);
    state.report = reportPath;
    if (agentCode !== 0) state.error = `agent 退出码 ${agentCode}（结果已收集，见日志）`;
    return { state, fixed: findings.filter((f) => f.fixed).length };
  } catch (e) {
    return { state: { ...state, error: (e as Error).message }, fixed: 0 };
  } finally {
    // 默认清理 worktree 和修复分支，--keep 留现场调试
    if (!opts.keep) {
      await sh(GIT, ["worktree", "remove", "--force", wt], { cwd: c.repo.path });
      await sh(GIT, ["branch", "-D", fixBranch], { cwd: c.repo.path });
    }
  }
}
