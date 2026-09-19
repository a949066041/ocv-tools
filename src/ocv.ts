#!/usr/bin/env bun
/**
 * ocv — 夜间批量审查 feature* 分支，自动修 critical/high，向 feature 分支提 PR。
 *
 * 零依赖、单文件。命令：
 *   ocv add <path> [--name x] [--base origin/master] [--branches "feature*,feat*"] [--pr gitee|github|manual]
 *   ocv status
 *   ocv run [--repo <glob>] [--branch <glob>] [--force] [--dry-run] [--keep] [--concurrency N]
 *
 * 分工：ocr 只做确定性的活（选文件 + 解析规则），审查和修复由无头 agent 干。
 * 这样不用给 ocr 配 LLM provider，同一份智能顺带把修复也做了。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CONFIG_PATH = join(ROOT, "ocv.config.json");
const STATE_PATH = join(ROOT, ".ocv-state.json");
const WT_DIR = join(ROOT, ".wt");
const RUN_DIR = join(ROOT, ".run");
const REPORT_DIR = join(ROOT, "reports");

const USAGE = `ocv — 夜间 feature 分支 OCR 审查 + 自动修复 + 提 PR

  ocv add <path> [--name x] [--base origin/master] [--branches "feature*,feat*"] [--pr gitee|github|manual]
  ocv status
  ocv config                                   # 打印有效配置 + 各路径（JSON，GUI 用）
  ocv run [--repo <glob>] [--branch <glob>] [--force] [--dry-run] [--keep] [--concurrency N]

配置: ${CONFIG_PATH}
状态: ${STATE_PATH}
报告: ${REPORT_DIR}/<日期>/INDEX.md`;

// ---------------------------------------------------------------- types

type PrKind = "gitee" | "github" | "manual";
type Severity = "critical" | "high" | "medium" | "low";

interface RepoCfg {
  name: string;
  path: string;
  enabled?: boolean;
  base?: string;
  branches?: string;
  pr?: PrKind;
  maxBranches?: number;
}

interface Config {
  git?: string;
  baseCandidates: string[];
  branches: string;
  maxAgeDays: number;
  maxBranches: number;
  maxFiles: number;
  concurrency: number;
  reportInRepo: string;
  agent: { bin: string; model?: string; timeoutMinutes: number; extraArgs?: string[] };
  pr: { giteeTokenEnv: string; githubTokenEnv: string };
  repos: RepoCfg[];
}

const DEFAULT_CONFIG: Config = {
  baseCandidates: ["origin/master", "origin/main"],
  branches: "feature*,feat*",
  maxAgeDays: 14,
  maxBranches: 5,
  maxFiles: 40,
  concurrency: 2,
  reportInRepo: ".code-review",
  agent: { bin: "omp", model: "", timeoutMinutes: 40, extraArgs: [] },
  pr: { giteeTokenEnv: "GITEE_TOKEN", githubTokenEnv: "GITHUB_TOKEN" },
  repos: [],
};

interface Finding {
  path: string;
  content: string;
  start_line?: number;
  end_line?: number;
  category?: string;
  severity: Severity;
  fixed?: boolean;
  fix_summary?: string;
}

interface Coverage {
  total_files?: number;
  reviewed_files?: number;
  skipped_files?: number;
  skipped?: { path: string; reason: string }[];
}

interface BranchState {
  sha: string;
  reviewedAt: string;
  fixBranch?: string;
  prUrl?: string;
  note?: string;
  counts?: Record<string, number>;
  report?: string;
  changedFiles?: number;
  commits?: number;
  error?: string;
}

interface State { branches: Record<string, BranchState> }

interface Candidate {
  repo: RepoCfg;
  branch: string;
  sha: string;
  mergeBase: string;
  commits: number;
  ts: number;
}

interface IndexEntry {
  repo: string;
  branch: string;
  counts: Record<string, number>;
  fixed: number;
  prUrl?: string;
  report: string;
  error?: string;
}

// ---------------------------------------------------------------- utils

function isSeverity(v: unknown): v is Severity {
  return v === "critical" || v === "high" || v === "medium" || v === "low";
}

function die(msg: string): never {
  console.error(`ocv: ${msg}`);
  process.exit(1);
}

/** 只读自有配置文件/状态文件：形状由本文件的写入方保证，外部输入不走这里 */
function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    die(`${path} 解析失败: ${(e as Error).message}`);
  }
}

function saveJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function loadConfig(): Config {
  const raw = loadJson<Partial<Config>>(CONFIG_PATH, {});
  return { ...DEFAULT_CONFIG, ...raw, agent: { ...DEFAULT_CONFIG.agent, ...raw.agent }, pr: { ...DEFAULT_CONFIG.pr, ...raw.pr } };
}

/** glob → regex，`*` 跨 `/` 匹配（与 git refspec 语义一致） */
function globToRe(globs: string): RegExp {
  const parts = globs.split(",").map((g) => g.trim()).filter(Boolean)
    .map((g) => g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  return new RegExp(`^(?:${parts.join("|")})$`);
}

// ---------------------------------------------------------------- git

let GIT = "git";
let GIT_DIR = "";

function gitVersionOf(bin: string): [number, number] | null {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const m = r.status === 0 && r.stdout ? /git version (\d+)\.(\d+)/.exec(r.stdout) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * 本机 PATH 里的 git 可能是 2019 年的 Apple installer 版（2.23），而 ocr 最低要 2.41，
 * 太旧会让 `ocr delegate preview` 直接报 "cannot find merge-base"。所以自己挑最新的那个。
 */
function resolveGit(cfg: Config): void {
  const named = spawnSync("which", ["git"], { encoding: "utf8" });
  const pathGit = named.status === 0 ? named.stdout.trim() : "";
  const cands = [cfg.git, process.env.OCV_GIT, "/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git", pathGit]
    .filter((c): c is string => !!c);
  let best: { bin: string; v: [number, number] } | null = null;
  for (const bin of cands) {
    const v = gitVersionOf(bin);
    if (!v) continue;
    if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && v[1] > best.v[1])) best = { bin, v };
  }
  if (!best) die("找不到可用的 git");
  GIT = best.bin;
  GIT_DIR = best.bin.startsWith("/") ? dirname(best.bin) : "";
  if (best.v[0] < 2 || (best.v[0] === 2 && best.v[1] < 41)) {
    console.error(`⚠️  git ${best.v.join(".")} 低于 ocr 要求的 2.41（${GIT}）。建议 brew install git；本次仍继续尝试。`);
  }
}

/** 子进程 PATH 前置新版 git 目录，免得 agent 里的 ocr 又拿到旧 git */
function childEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (GIT_DIR) env.PATH = `${GIT_DIR}:${env.PATH ?? ""}`;
  return env;
}

interface ExecResult { code: number; out: string; err: string }

async function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: out.trim(), err: err.trim() };
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await sh(GIT, args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失败: ${r.err || r.out}`);
  return r.out;
}

async function gitOrNull(args: string[], cwd: string): Promise<string | null> {
  const r = await sh(GIT, args, { cwd });
  return r.code === 0 ? r.out : null;
}

// ---------------------------------------------------------------- remote / PR

function parseRemote(url: string): { host: string; owner: string; repo: string } | null {
  const u = url.trim();
  if (u.startsWith("/") || u.startsWith(".") || u.startsWith("file://")) {
    const repo = u.replace(/^file:\/\//, "").replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "");
    return repo ? { host: "local", owner: "", repo } : null;
  }
  const m = /^(?:git@|https?:\/\/)([^:/]+)[:/](.+?)(?:\.git)?$/.exec(u);
  if (!m) return null;
  const segs = m[2].split("/");
  const repo = segs.pop()!;
  return { host: m[1], owner: segs.join("/"), repo };
}

function prKindFor(host: string, repo: RepoCfg): PrKind {
  if (repo.pr) return repo.pr;
  if (host.includes("gitee.com")) return "gitee";
  if (host.includes("github.com")) return "github";
  return "manual";
}

interface PrResult { url: string; note?: string }

/** PR 接口响应只需要这三个字段；类型不符一律当缺省，不猜其余结构 */
interface PrApiResponse { html_url?: unknown; error?: unknown; message?: unknown }

/** Orca automation 起的 agent 拿不到你交互 shell 里的 env，所以也认 .ocv.secrets.json */
function prToken(cfg: Config, kind: "gitee" | "github"): string | undefined {
  const name = kind === "gitee" ? cfg.pr.giteeTokenEnv : cfg.pr.githubTokenEnv;
  return process.env[name] ?? loadJson<Record<string, string>>(join(ROOT, ".ocv.secrets.json"), {})[name];
}

async function createPr(
  kind: PrKind, remote: { host: string; owner: string; repo: string }, cfg: Config,
  fixBranch: string, baseBranch: string, title: string, body: string,
): Promise<PrResult> {
  if (remote.host === "local") return { url: "", note: "本地 remote：分支已推送，无 PR 平台可提交" };
  const manualUrl = kind === "gitee"
    ? `https://gitee.com/${remote.owner}/${remote.repo}/compare/${baseBranch}...${fixBranch}`
    : `https://${remote.host}/${remote.owner}/${remote.repo}/compare/${baseBranch}...${fixBranch}?expand=1`;

  if (kind === "manual") return { url: manualUrl, note: "该平台未接 API：分支已推送，请打开链接手动创建 PR" };
  const token = prToken(cfg, kind);
  if (!token) {
    const envName = kind === "gitee" ? cfg.pr.giteeTokenEnv : cfg.pr.githubTokenEnv;
    return { url: manualUrl, note: `缺少 ${envName}（可写进 .ocv.secrets.json）：分支已推送，请手动创建 PR` };
  }

  const [api, headers, payload] = kind === "gitee"
    ? [`https://gitee.com/api/v5/repos/${remote.owner}/${remote.repo}/pulls`,
       { "Content-Type": "application/json" },
       { access_token: token, title, head: fixBranch, base: baseBranch, body }]
    : [`https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`,
       { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
       { title, head: fixBranch, base: baseBranch, body }];

  try {
    const res = await fetch(api, { method: "POST", headers, body: JSON.stringify(payload) });
    const j = (await res.json()) as PrApiResponse;
    if (!res.ok) {
      const why = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
      return { url: manualUrl, note: `${kind} PR 创建失败(${res.status}): ${why}` };
    }
    return { url: typeof j.html_url === "string" ? j.html_url : manualUrl };
  } catch (e) {
    return { url: manualUrl, note: `创建 PR 异常: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------- scan

async function pickBase(cfg: Config, repo: RepoCfg): Promise<string> {
  const cands = repo.base ? [repo.base, ...cfg.baseCandidates.filter((b) => b !== repo.base)] : cfg.baseCandidates;
  for (const b of cands) {
    if (await gitOrNull(["rev-parse", "--verify", "--quiet", b], repo.path)) return b;
  }
  die(`${repo.name}: 找不到基线分支（试过 ${cands.join(", ")}），请在 config 里指定 base`);
}

async function scanRepo(cfg: Config, state: State, repo: RepoCfg, opts: { force: boolean; branchFilter?: RegExp }): Promise<{ candidates: Candidate[]; skipped: string[] }> {
  const skipped: string[] = [];
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

// ---------------------------------------------------------------- agent

const slugOfRepoBranch = (repoName: string, branch: string) => `${repoName}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;

/**
 * `bun run` 会把沿途各层 node_modules/.bin 塞进 PATH，$HOME/node_modules/.bin/omp 之类
 * 的旧 shim 会盖掉真正的 agent 可执行文件。挑 agent 时跳过这些 .bin 目录。
 */
function resolveAgentBin(name: string): string {
  if (name.includes("/")) return name;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir || dir.includes("node_modules")) continue;
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return name;
}

function buildPrompt(c: Candidate, base: string, fixBranch: string, runDir: string): string {
  const ws = join(WT_DIR, slugOfRepoBranch(c.repo.name, c.branch));
  const findingsPath = join(runDir, "findings.json");
  return `你是夜间代码审查机器人。任务：审查 ${c.branch} 相对 ${base} 的改动，只修 critical/high，产出结构化结果。

仓库: ${c.repo.name} (${c.repo.path})
工作区: ${ws}   ← 你现在就在这里，已 checkout 出修复分支 ${fixBranch}
对比范围: merge-base ${c.mergeBase} .. ${c.branch} ${c.sha}（共 ${c.commits} 个提交）
文件清单已生成，直接读，不要重跑 preview: ${join(runDir, "preview.json")}
结果必须写入(绝对路径，在工作区之外): ${findingsPath}

硬性约束:
- 不要 push、不要切换分支、不要新建分支、不要改 git 历史。
- 只修 critical/high；medium/low 一律不动，留给人工判断。
- 只改与 finding 对应的源码文件；不要提交任何临时文件、日志、依赖目录。

步骤:
1. 读取并遵循 skill://open-code-review-delegate 的流程与输出规范。
2. 读 ${join(runDir, "preview.json")} 拿到 reviewable_files，不要重复执行 preview。
3. 运行 ocr delegate rule --repo ${c.repo.path} --from ${c.mergeBase} --to ${c.sha} --format json <上一步所有 path>
   （path 太多就分批），得到每个文件适用的审查规则。
4. 逐文件看改动 git diff ${c.mergeBase}..${c.sha} -- <path>，按规则审查。
   必须覆盖全部 reviewable 文件；跳过的要写明理由；不要找到一个高危就收工。
5. 把全部发现写进 ${findingsPath}，schema：
   {"schema_version":"1",
    "coverage":{"total_files":N,"reviewed_files":N,"skipped_files":N,"skipped":[{"path":"","reason":""}]},
    "findings":[{"path":"相对路径","content":"中文问题描述","start_line":1,"end_line":2,
                 "category":"bug|security|performance|maintainability|test|style|documentation|other",
                 "severity":"critical|high|medium|low","fixed":false,"fix_summary":""}]}
   这是硬性产物，必须写；没发现问题就写空数组。
6. 修复 critical/high：改完把该 finding 的 fixed 置 true、fix_summary 写一句话说明改了什么。
7. 轻量验证（针对改动文件的 lint/单测）即可；不要跑全量测试，任何命令不要超过 3 分钟。
8. git add <只 add 你实际改动的源码文件> && git commit -m "fix(review): <一句话中文>"
   如果没有任何修复，就不要 commit。
9. 最后用中文输出简短总结：审查文件数、各严重级别数量、修了几条。`;
}

async function runAgent(cfg: Config, prompt: string, workdir: string, runDir: string, logPath: string, tag: string): Promise<number> {
  const bin = resolveAgentBin(cfg.agent.bin);
  const args = [bin, "-p", "--auto-approve", "--no-title", "--add-dir", runDir,
    "--max-time", `${cfg.agent.timeoutMinutes}m`];
  if (cfg.agent.model) args.push("--model", cfg.agent.model);
  if (cfg.agent.extraArgs?.length) args.push(...cfg.agent.extraArgs);
  args.push(prompt);

  writeFileSync(join(runDir, "prompt.txt"), prompt);
  writeFileSync(logPath, `$ ${args.slice(0, -1).join(" ")} <prompt>\n\n`);
  console.log(`  ⏳ ${tag} agent 启动（上限 ${cfg.agent.timeoutMinutes} 分钟）`);

  const proc = Bun.spawn(args, { cwd: workdir, env: childEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const started = Date.now();
  // omp -p 中途基本不出声，靠心跳证明还活着（GUI 的日志面板就看 stdout）
  const beat = setInterval(() => {
    console.log(`     ⋯ ${tag} 审查中，已 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`);
  }, 30000);

  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      appendFileSync(logPath, text);
      rest += text;
      for (let cut = rest.indexOf("\n"); cut >= 0; cut = rest.indexOf("\n")) {
        const line = rest.slice(0, cut);
        rest = rest.slice(cut + 1);
        if (line.trim()) console.log(`     │ ${tag} ${line}`);
      }
    }
    if (rest.trim()) console.log(`     │ ${tag} ${rest}`);
  };

  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  clearInterval(beat);
  console.log(`  ⏱ ${tag} agent 结束：退出码 ${code}，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`);
  return code;
}

// ---------------------------------------------------------------- findings / report

function readFindings(path: string): { findings: Finding[]; coverage: Coverage | null } {
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

function countBy(findings: Finding[]): Record<string, number> {
  const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
  return c;
}

const escapeCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

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

interface RunFacts {
  base: string;
  fixBranch: string;
  findings: Finding[];
  coverage: Coverage | null;
  changedFiles: number;
  prUrl: string;
  note?: string;
  logPath: string;
  repoReport?: string;
}

/** forRepo=true 时生成的是提交进仓库、给同事看的那份：不带本地路径，带复查命令 */
function buildReport(c: Candidate, f: RunFacts, forRepo = false): string {
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

function buildPrBody(c: Candidate, f: RunFacts): string {
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

function writeIndex(date: string, entries: IndexEntry[]) {
  const dir = join(REPORT_DIR, date);
  mkdirSync(dir, { recursive: true });
  const head = "| 仓库 | 分支 | critical | high | medium | low | 已修 | PR | 报告 |\n|---|---|---|---|---|---|---|---|---|\n";
  const rows = entries.map((e) => {
    const rel = e.report.replace(`${dir}/`, "");
    const pr = e.prUrl ? `[链接](${e.prUrl})` : (e.error ? `失败: ${escapeCell(e.error)}` : "-");
    return `| ${e.repo} | ${e.branch} | ${e.counts.critical ?? 0} | ${e.counts.high ?? 0} | ${e.counts.medium ?? 0} | ${e.counts.low ?? 0} | ${e.fixed} | ${pr} | [${rel}](${encodeURIComponent(rel)}) |`;
  });
  writeFileSync(join(dir, "INDEX.md"), `# 夜间代码审查 ${date}\n\n${head}${rows.join("\n")}\n`);
}

// ---------------------------------------------------------------- pipeline

async function processCandidate(cfg: Config, c: Candidate, keep: boolean): Promise<{ state: BranchState; fixed: number }> {
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

// ---------------------------------------------------------------- commands

function cmdStatus(cfg: Config) {
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

async function cmdRun(cfg: Config, args: { repo?: string; branch?: string; force: boolean; dryRun: boolean; keep: boolean; concurrency?: number }) {
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

function cmdAdd(cfg: Config, path: string, opts: { name?: string; base?: string; branches?: string; pr?: PrKind }) {
  const abs = resolve(path.replace(/^~/, process.env.HOME ?? "~"));
  if (!existsSync(join(abs, ".git"))) die(`${abs} 不是 git 仓库`);
  const name = opts.name ?? abs.split("/").pop()!;
  if (cfg.repos.some((r) => r.name === name)) die(`仓库 ${name} 已存在`);
  cfg.repos.push({ name, path: abs, base: opts.base, branches: opts.branches, pr: opts.pr, enabled: true });
  saveJson(CONFIG_PATH, cfg);
  console.log(`已添加 ${name} → ${abs}`);
}

// ---------------------------------------------------------------- cli

function parseFlags(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { _.push(a); continue; }
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith("-")) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { _, flags };
}

async function main() {
  const { _, flags } = parseFlags(process.argv.slice(2));
  const [cmd, ...rest] = _;
  if (!cmd || cmd === "help" || flags.help) {
    console.log(USAGE);
    return;
  }

  const cfg = loadConfig();
  resolveGit(cfg);

  if (cmd === "add") {
    if (!rest[0]) die("用法: ocv add <path>");
    cmdAdd(cfg, rest[0], {
      name: typeof flags.name === "string" ? flags.name : undefined,
      base: typeof flags.base === "string" ? flags.base : undefined,
      branches: typeof flags.branches === "string" ? flags.branches : undefined,
      pr: typeof flags.pr === "string" ? (flags.pr as PrKind) : undefined,
    });
    return;
  }
  if (cmd === "config") {
    // GUI/其他工具读配置的唯一入口：有效配置（已合并默认值）+ 各路径
    console.log(JSON.stringify({
      ...cfg,
      _paths: { root: ROOT, config: CONFIG_PATH, state: STATE_PATH, reports: REPORT_DIR, run: RUN_DIR, worktrees: WT_DIR },
    }, null, 2));
    return;
  }
  if (cmd === "status") {
    cmdStatus(cfg);
    return;
  }
  if (cmd === "run") {
    await cmdRun(cfg, {
      repo: typeof flags.repo === "string" ? flags.repo : undefined,
      branch: typeof flags.branch === "string" ? flags.branch : undefined,
      force: !!flags.force,
      dryRun: !!flags["dry-run"],
      keep: !!flags.keep,
      concurrency: typeof flags.concurrency === "string" ? Number(flags.concurrency) : undefined,
    });
    return;
  }
  die(`未知命令: ${cmd}（ocv help）`);
}

await main();