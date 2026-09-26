import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitAll, g, makeRepo, tmpRoot } from "./helpers.js";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tmp = "";
let work = "";
let origin = "";
let root = "";
let binDir = "";

/** 假 ocr:只实现 pipeline 用到的 delegate preview;OCV_FAKE_OCR_MODE 控制 reviewable 数量 */
const FAKE_OCR = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "open-code-review fake"; exit 0; fi
if [ "$1" != "delegate" ] || [ "$2" != "preview" ]; then echo "unsupported: $*" >&2; exit 2; fi
shift 2
repo=""; from=""; to=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2;;
    --from) from="$2"; shift 2;;
    --to) to="$2"; shift 2;;
    *) shift;;
  esac
done
if [ "$OCV_FAKE_OCR_MODE" = "empty" ]; then
  echo "{\\"schema_version\\":\\"1\\",\\"reviewable_count\\":0,\\"reviewable_files\\":[]}"
  exit 0
fi
if [ "$OCV_FAKE_OCR_MODE" = "many" ]; then
  echo "{\\"schema_version\\":\\"1\\",\\"reviewable_count\\":999,\\"reviewable_files\\":[\\"app.txt\\"]}"
  exit 0
fi
files=$(git -C "$repo" diff --name-only "$from..$to")
n=$(printf '%s' "$files" | grep -c . || true)
list=$(printf '%s' "$files" | grep . | sed 's/.*/"&"/' | paste -sd, -)
echo "{\\"schema_version\\":\\"1\\",\\"repository\\":\\"$repo\\",\\"from\\":\\"$from\\",\\"merge_base\\":\\"$from\\",\\"to\\":\\"$to\\",\\"total_files\\":$n,\\"reviewable_count\\":$n,\\"excluded_count\\":0,\\"total_insertions\\":1,\\"total_deletions\\":1,\\"reviewable_files\\":[$list],\\"excluded_files\\":[]}"
`;

/** 假 agent:写 findings(一条 high 已修 + 一条 medium 不动),改源码并 commit */
const FAKE_AGENT = `#!/bin/sh
prompt="\${@: -1}"
findings=$(printf '%s' "$prompt" | grep -o '结果必须写入(绝对路径，在工作区之外): [^ ]*' | sed 's/.*: //')
[ -n "$findings" ] || { echo "prompt 里没有 findings 路径" >&2; exit 3; }
cat > "$findings" <<'EOF'
{"schema_version":"1",
 "coverage":{"total_files":1,"reviewed_files":1,"skipped_files":0,"skipped":[]},
 "findings":[
   {"path":"app.txt","content":"占位实现","start_line":1,"end_line":1,"category":"bug","severity":"high","fixed":true,"fix_summary":"补上真实实现"},
   {"path":"app.txt","content":"命名可以更清楚","start_line":1,"end_line":1,"category":"style","severity":"medium","fixed":false}]}
EOF
printf 'fixed\\n' > app.txt
git add app.txt
git commit -m "fix(review): 补上真实实现"
echo "审查完成: 2 条发现, 修 1 条"
`;

function runCli(args: string[], opts: { stdinFile?: string; env?: Record<string, string> } = {}) {
  return Bun.spawnSync(["bun", CLI, ...args], {
    cwd: root,
    env: { ...process.env, OCV_ROOT: root, PATH: `${binDir}:${process.env.PATH}`, ...opts.env },
    stdin: opts.stdinFile ? Bun.file(opts.stdinFile) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeAll(() => {
  tmp = tmpRoot();
  const repo = makeRepo(tmp);
  work = repo.work;
  origin = repo.origin;
  writeFileSync(join(work, "app.txt"), "todo\n");
  commitAll(work, "init");
  g(work, ["push", "origin", "master"]);
  g(work, ["checkout", "-b", "feat/demo"]);
  writeFileSync(join(work, "app.txt"), "todo2\n");
  commitAll(work, "feat demo");
  g(work, ["push", "origin", "feat/demo"]);
  // 第二个分支:供 empty/many 模式预筛路径使用
  g(work, ["checkout", "-b", "feat/empty", "master"]);
  writeFileSync(join(work, "e.txt"), "e\n");
  commitAll(work, "feat empty");
  g(work, ["push", "origin", "feat/empty"]);
  g(work, ["checkout", "master"]);

  root = join(tmpRoot(), "root");
  mkdirSync(root, { recursive: true });
  binDir = join(tmpRoot(), "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "ocr"), FAKE_OCR);
  writeFileSync(join(binDir, "fake-agent"), FAKE_AGENT);
  chmodSync(join(binDir, "ocr"), 0o755);
  chmodSync(join(binDir, "fake-agent"), 0o755);
  writeFileSync(join(root, "ocv.config.json"), JSON.stringify({
    branches: "feat/*",
    concurrency: 1,
    maxFiles: 10,
    agent: { bin: join(binDir, "fake-agent"), timeoutMinutes: 5 },
    repos: [{ name: "demo", path: work, pr: "manual" }],
  }));
});

describe("e2e 闭环", () => {
  test("run 全流程:扫描→agent→修复→推送→报告→状态", () => {
    // dry-run 只扫不改
    const dry = runCli(["run", "--dry-run", "--branch", "feat/demo"]);
    expect(dry.exitCode).toBe(0);
    const dryOut = dry.stdout.toString();
    expect(dryOut).toContain("feat/demo");
    expect(dryOut).toContain("(dry-run)");
    expect(existsSync(join(root, ".ocv-state.json"))).toBe(false);

    // 真跑
    const r = runCli(["run", "--branch", "feat/demo"]);
    const out = r.stdout.toString() + r.stderr.toString();
    expect(r.exitCode, out).toBe(0);
    expect(out).toContain("✔ demo/feat/demo");

    // 状态:计数 + 本地 remote 无 PR 说明
    const state = JSON.parse(readFileSync(join(root, ".ocv-state.json"), "utf8"));
    const st = state.branches["demo|feat/demo"];
    expect(st.counts).toMatchObject({ critical: 0, high: 1, medium: 1, low: 0 });
    expect(st.error).toBeUndefined();
    expect(st.note).toContain("本地 remote");

    // 日期一致性:state/修复分支/报告/INDEX 同一天
    const date = st.reviewedAt.slice(0, 10);
    expect(st.fixBranch).toContain(date);
    expect(st.report).toBe(join(root, "reports", date, "demo-feat-demo.md"));

    // 修复分支推到 origin,含修复提交 + 仓库内报告
    const branches = g(tmp, ["ls-remote", "--heads", origin]);
    expect(branches).toContain("ocr-review/feat-demo-");
    const wt = join(tmpRoot(), "check");
    g(tmp, ["clone", "-b", st.fixBranch, origin, wt]);
    expect(readFileSync(join(wt, "app.txt"), "utf8").trim()).toBe("fixed");
    expect(readFileSync(join(wt, ".code-review", "feat-demo.md"), "utf8")).toContain("占位实现");
    // 机器人署名:agent 子进程和 ocv 自己的提交都用 bot 身份,不碰仓库 user.name
    expect(g(wt, ["log", "-1", "--format=%an <%ae>"])).toBe("ocv-bot <ocv-bot@noreply.local>");

    // 本地报告 + INDEX
    const report = readFileSync(st.report, "utf8");
    expect(report).toContain("# demo / feat/demo");
    expect(report).toContain("已自动修复 1 条");
    const index = readFileSync(join(root, "reports", date, "INDEX.md"), "utf8");
    expect(index).toContain("| demo | feat/demo |");

    // 同 sha 再跑:跳过,不重复烧 agent
    const again = runCli(["run", "--branch", "feat/demo"]);
    const againOut = again.stdout.toString();
    expect(againOut).toContain("与上次审查同一提交");
    expect(againOut).toContain("没有需要处理的分支");
  }, 120_000);

  test("预筛:无可审文件不烧 agent", () => {
    const r = runCli(["run", "--branch", "feat/empty"], { env: { OCV_FAKE_OCR_MODE: "empty" } });
    expect(r.exitCode).toBe(0);
    const st = JSON.parse(readFileSync(join(root, ".ocv-state.json"), "utf8")).branches["demo|feat/empty"];
    expect(st.error).toBe("无可审文件");
    expect(existsSync(join(root, ".run", "demo-feat-empty", "log.txt"))).toBe(false);
  }, 60_000);

  test("预筛:超 maxFiles 留给人工", () => {
    const r = runCli(["run", "--branch", "feat/empty", "--force"], { env: { OCV_FAKE_OCR_MODE: "many" } });
    expect(r.exitCode).toBe(0);
    const st = JSON.parse(readFileSync(join(root, ".ocv-state.json"), "utf8")).branches["demo|feat/empty"];
    expect(st.error).toContain("超过 maxFiles=10");
    expect(st.changedFiles).toBe(999);
  }, 60_000);

  test("save-config 校验:坏 JSON 拒收、token 本体拒收、合法配置落盘", () => {
    const badFile = join(root, "bad.json");
    writeFileSync(badFile, "{");
    expect(runCli(["save-config"], { stdinFile: badFile }).exitCode).not.toBe(0);

    const leakFile = join(root, "leak.json");
    writeFileSync(leakFile, JSON.stringify({ pr: { giteeTokenEnv: "64dbfccfa767a89d7a740932e57ccf62" } }));
    const leak = runCli(["save-config"], { stdinFile: leakFile });
    expect(leak.exitCode).not.toBe(0);
    expect(leak.stderr.toString()).toContain("环境变量名");

    const okFile = join(root, "ok.json");
    writeFileSync(okFile, readFileSync(join(root, "ocv.config.json"), "utf8"));
    expect(runCli(["save-config"], { stdinFile: okFile }).exitCode).toBe(0);
  });

  test("status 展示上次结果", () => {
    const r = runCli(["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("demo\tfeat/demo");
  });
});
