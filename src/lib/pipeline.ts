/**
 * 核心流水线：处理单个 candidate 的完整生命周期。
 * worktree 创建 → ocr preview → agent 审查 → 收集结果 → 推送 → PR → 报告。
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Candidate, BranchState, Config, PrResult } from "./types";
import { WT_DIR, RUN_DIR, REPORT_DIR } from "./constants";
import { slugOfRepoBranch } from "./utils";
import { sh, git, gitOrNull } from "./git";
import { pickBase } from "./scan";
import { buildPrompt, runAgent } from "./agent";
import { readFindings, countBy } from "./findings";
import { buildReport, buildPrBody, type RunFacts } from "./report";
import { parseRemote, prKindFor, createPr } from "./pr";

export async function processCandidate(cfg: Config, c: Candidate, keep: boolean): Promise<{ state: BranchState; fixed: number }> {
  const slug = slugOfRepoBranch(c.repo.name, c.branch);
  const wt = join(WT_DIR, slug);
  const runDir = join(RUN_DIR, slug);
  const date = new Date().toISOString().slice(0, 10);
  const fixBranch = `ocr-review/${c.branch.replace(/[^A-Za-z0-9._-]+/g, "-")}-${date}-${c.sha.slice(0, 7)}`;
  const logPath = join(runDir, "log.txt");
  const findingsPath = join(runDir, "findings.json");
  const base = await pickBase(cfg, c.repo);
  const reportPath = join(REPORT_DIR, date, `${slug}.md`);

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
    state.changedFiles = "reviewable_count" in parsed && typeof parsed.reviewable_count === "number" ? parsed.reviewable_count : 0;
    if (!state.changedFiles) return { state: { ...state, error: "无可审文件" }, fixed: 0 };
    if (state.changedFiles > cfg.maxFiles) return { state: { ...state, error: `改动 ${state.changedFiles} 个文件，超过 maxFiles=${cfg.maxFiles}，留给人工审查` }, fixed: 0 };

    // 2) worktree + 修复分支
    rmSync(wt, { recursive: true, force: true });
    await sh(GIT, ["worktree", "prune"], { cwd: c.repo.path });
    await sh(GIT, ["branch", "-D", fixBranch], { cwd: c.repo.path });
    const add = await sh(GIT, ["worktree", "add", "-b", fixBranch, wt, c.sha], { cwd: c.repo.path });
    if (add.code !== 0) throw new Error(`git worktree add 失败: ${add.err}`);
    // worktree 继承主仓库的 git hooks（如 husky/lint-staged），但没有 node_modules → hook 必失败。
    // 禁用 hooks 只影响这个 worktree，不影响主仓库里的日常工作。
    await sh(GIT, ["config", "core.hooksPath", "/dev/null"], { cwd: wt });

    // 3) 无头 agent：审查 + 修 critical/high + commit
    const agentCode = await runAgent(cfg, buildPrompt(c, base, fixBranch, runDir), wt, runDir, logPath, slug);

    // 4) 收结果
    const { findings, coverage } = readFindings(findingsPath);
    const counts = countBy(findings);
    state.counts = counts;

    const dirty = ((await gitOrNull(["status", "--porcelain"], wt)) ?? "").split("\n").filter(Boolean);
    if (dirty.length) {
      // 兜底：agent 改了没提交 → 只提交 findings 里标了 fixed 的路径，其余脏文件丢弃
      const fixPaths = findings.filter((f) => f.fixed).map((f) => f.path);
      if (fixPaths.length) {
        await sh(GIT, ["add", "--", ...fixPaths], { cwd: wt });
        await sh(GIT, ["commit", "-m", "fix(review): 夜间自动修复 critical/high"], { cwd: wt });
      }
      await sh(GIT, ["checkout", "--", "."], { cwd: wt });
      await sh(GIT, ["clean", "-fd"], { cwd: wt });
    }
    const codeChanged = ((await gitOrNull(["diff", "--name-only", `${c.sha}..HEAD`], wt)) ?? "").split("\n").filter(Boolean);

    // 5) 全部发现（含 medium/low）写成报告提交进分支：不看本地目录的同事在对比/PR 里也能看到
    let repoReport = "";
    if (cfg.reportInRepo && findings.length) {
      repoReport = `${cfg.reportInRepo.replace(/\/+$/, "")}/${c.branch.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`;
      const abs = join(wt, repoReport);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, buildReport(c, { base, fixBranch, findings, coverage, changedFiles: codeChanged.length, prUrl: "", logPath }, true));
      await sh(GIT, ["add", "--", repoReport], { cwd: wt });
      const commit = await sh(GIT, ["commit", "-m",
        `chore(review): 夜间审查发现 ${counts.critical} critical / ${counts.high} high / ${counts.medium} medium / ${counts.low} low`], { cwd: wt });
      if (commit.code !== 0) {
        rmSync(abs, { force: true });
        console.log(`  ⚠️ ${slug} 审查报告提交失败（${commit.err}），只在本地留档`);
        repoReport = "";
      } else {
        console.log(`  📄 ${slug} 审查报告已提交到分支: ${repoReport}`);
      }
    }
    const changed = ((await gitOrNull(["diff", "--name-only", `${c.sha}..HEAD`], wt)) ?? "").split("\n").filter(Boolean);

    // 6) 有改动（代码修复或那份报告）就推 + 提 PR
    let pr: PrResult = { url: "" };
    if (changed.length) {
      const push = await sh(GIT, ["push", "--force-with-lease", "-u", "origin", `${fixBranch}:${fixBranch}`], { cwd: wt });
      if (push.code !== 0) throw new Error(`git push 失败: ${push.err}`);
      const remote = parseRemote(await git(["remote", "get-url", "origin"], c.repo.path));
      if (!remote) throw new Error("无法解析 origin URL");
      const fixedN = findings.filter((f) => f.fixed).length;
      const facts: RunFacts = { base, fixBranch, findings, coverage, changedFiles: codeChanged.length, prUrl: "", logPath, repoReport };
      pr = await createPr(prKindFor(remote.host, c.repo), remote, cfg, fixBranch, c.branch,
        fixedN
          ? `[夜间审查] ${c.repo.name}/${c.branch}：自动修复 ${fixedN} 条，另有 ${findings.length - fixedN} 条待人工判断`
          : `[夜间审查] ${c.repo.name}/${c.branch}：${findings.length} 条发现（未自动修改代码）`,
        buildPrBody(c, facts));
      state.prUrl = pr.url;
    } else if (findings.length) {
      pr = { url: "", note: "本次没有可自动修复的 critical/high，未创建 PR（问题已写进报告）" };
    }
    if (pr.note) state.note = pr.note;

    const report = buildReport(c, { base, fixBranch, findings, coverage, changedFiles: codeChanged.length, prUrl: pr.url, note: pr.note, logPath, repoReport });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report);
    state.report = reportPath;
    if (agentCode !== 0) state.error = `agent 退出码 ${agentCode}（结果已收集，见日志）`;
    return { state, fixed: findings.filter((f) => f.fixed).length };
  } catch (e) {
    return { state: { ...state, error: (e as Error).message }, fixed: 0 };
  } finally {
    if (!keep) {
      await sh(GIT, ["worktree", "remove", "--force", wt], { cwd: c.repo.path });
      await sh(GIT, ["branch", "-D", fixBranch], { cwd: c.repo.path });
    }
  }
}