import "./setup-root.js";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRe } from "../src/config.js";
import { parseRemote, prKindFor } from "../src/pr.js";
import { readFindings, countBy, buildReport, buildPrBody, writeIndex } from "../src/report.js";
import { slugOfRepoBranch } from "../src/agent.js";
import { notifyRepo, summarizeRepo } from "../src/notify.js";
import { configSchema, assertTokenEnvNames } from "../src/schema.js";
import type { Candidate, Config, Finding, IndexEntry, RunFacts } from "../src/types.js";

const cfg = configSchema.parse({});

describe("configSchema", () => {
  test("空配置落到默认值", () => {
    expect(cfg.branches).toBe("feature*,feat*");
    expect(cfg.concurrency).toBe(2);
    expect(cfg.agent.bin).toBe("omp");
    expect(cfg.pr.giteeTokenEnv).toBe("GITEE_TOKEN");
    expect(cfg.repos).toEqual([]);
    expect(cfg.commit).toEqual({ name: "ocv-bot", email: "ocv-bot@noreply.local" });
  });
  test("坏仓库条目被拒", () => {
    expect(configSchema.safeParse({ repos: [{ name: "x" }] }).success).toBe(false);
  });
  test("token 本体写进 TokenEnv 字段要报错", () => {
    const bad = configSchema.parse({ pr: { giteeTokenEnv: "64dbfccfa767a89d7a740932e57ccf62" } });
    expect(() => assertTokenEnvNames(bad)).toThrow(/环境变量名/);
    expect(() => assertTokenEnvNames(cfg)).not.toThrow();
  });
});

describe("globToRe", () => {
  test("逗号分隔 + * 跨 /", () => {
    const re = globToRe("feat/*, feature*");
    expect(re.test("feat/a/b")).toBe(true);
    expect(re.test("feature-x")).toBe(true);
    expect(re.test("master")).toBe(false);
  });
  test("点号按字面匹配", () => {
    expect(globToRe("feat/rpt3.0").test("feat/rpt3x0")).toBe(false);
    expect(globToRe("feat/rpt3.0").test("feat/rpt3.0")).toBe(true);
  });
});

describe("parseRemote", () => {
  test("ssh / https / 嵌套 owner", () => {
    expect(parseRemote("git@github.com:owner/repo.git")).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
    expect(parseRemote("https://github.com/owner/repo")).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
    expect(parseRemote("git@gitee.com:group/sub/repo.git")).toEqual({ host: "gitee.com", owner: "group/sub", repo: "repo" });
  });
  test("本地路径与 file:// 归为 local", () => {
    expect(parseRemote("/tmp/x/origin.git")).toEqual({ host: "local", owner: "", repo: "origin" });
    expect(parseRemote("file:///tmp/x/origin")).toEqual({ host: "local", owner: "", repo: "origin" });
  });
  test("无法解析返回 null", () => {
    expect(parseRemote("not a url")).toBeNull();
  });
});

describe("prKindFor", () => {
  const repo = { name: "r", path: "/tmp/r" };
  test("repo.pr 覆盖优先", () => {
    expect(prKindFor("github.com", { ...repo, pr: "manual" })).toBe("manual");
  });
  test("按 host 推断，其余 manual", () => {
    expect(prKindFor("gitee.com", repo)).toBe("gitee");
    expect(prKindFor("github.com", repo)).toBe("github");
    expect(prKindFor("gitlab.corp", repo)).toBe("manual");
  });
});

describe("readFindings 容错", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ocv-unit-"));
  test("文件不存在 → 空结果", () => {
    expect(readFindings(join(tmp, "nope.json"))).toEqual({ findings: [], coverage: null });
  });
  test("坏条目丢弃、缺 severity 落 medium", () => {
    const p = join(tmp, "f.json");
    writeFileSync(p, JSON.stringify({
      findings: [
        { path: "a.ts", content: "x", severity: "high", fixed: true },
        { content: "缺 path" },
        "字符串",
        { path: "b.ts", content: "y" },
      ],
      coverage: { total_files: 2, reviewed_files: 1, skipped_files: 1, skipped: [{ path: "c.ts", reason: "二进制" }, 42] },
    }));
    const { findings, coverage } = readFindings(p);
    expect(findings.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(findings[0].fixed).toBe(true);
    expect(findings[1].severity).toBe("medium");
    expect(coverage?.skipped).toEqual([{ path: "c.ts", reason: "二进制" }]);
  });
  test("非 JSON 顶层 → 空结果", () => {
    const p = join(tmp, "bad.json");
    writeFileSync(p, "[1,2,3]");
    expect(readFindings(p).findings).toEqual([]);
  });
});

describe("countBy", () => {
  test("按级别计数且四级齐全", () => {
    const f = (severity: Finding["severity"]): Finding => ({ path: "a", content: "c", severity });
    expect(countBy([f("high"), f("high"), f("low")])).toEqual({ critical: 0, high: 2, medium: 0, low: 1 });
  });
});

const candidate: Candidate = { repo: { name: "demo", path: "/tmp/demo" }, branch: "feat/x", sha: "abcdef1234567890", mergeBase: "1234567890abcdef", commits: 2 };
const facts: RunFacts = {
  base: "origin/master", fixBranch: "ocr-review/feat-x", changedFiles: 1, logPath: "/tmp/log.txt",
  prUrl: "https://pr/1", note: "备注",
  findings: [
    { path: "a.ts", content: "高危|问题", start_line: 1, end_line: 2, severity: "high", fixed: true, fix_summary: "改了" },
    { path: "b.ts", content: "低危", severity: "low" },
  ],
  coverage: { total_files: 2, reviewed_files: 2, skipped_files: 0, skipped: [] },
};

describe("报告生成", () => {
  test("本地报告带 PR 行与转义", () => {
    const md = buildReport(candidate, facts);
    expect(md).toContain("- PR: [https://pr/1]");
    expect(md).toContain("高危\\|问题");
    expect(md).toContain("已自动修复 1 条");
    expect(md).toContain("/tmp/log.txt");
  });
  test("仓库内报告不带本地路径", () => {
    const md = buildReport(candidate, facts, true);
    expect(md).not.toContain("/tmp/log.txt");
    expect(md).not.toContain("- PR:");
    expect(md).toContain("ocr delegate preview");
  });
  test("PR body 含计数与完整清单指引", () => {
    const body = buildPrBody(candidate, { ...facts, repoReport: ".code-review/feat-x.md" });
    expect(body).toContain("critical 0 / high 1");
    expect(body).toContain(".code-review/feat-x.md");
  });
  test("writeIndex 落 INDEX.md 且链接相对", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocv-idx-"));
    const date = "2026-01-01";
    writeIndex(date, [{ repo: "demo", branch: "feat/x", counts: { critical: 0, high: 1, medium: 0, low: 0 }, fixed: 1, report: join(dir, date, "demo-feat-x.md"), prUrl: "https://pr/1" }], dir);
    const md = readFileSync(join(dir, date, "INDEX.md"), "utf8");
    expect(md).toContain("| demo | feat/x | 0 | 1 | 0 | 0 | 1 |");
    expect(md).toContain("(demo-feat-x.md)");
  });
});

describe("slugOfRepoBranch", () => {
  test("非安全字符替换为 -", () => {
    expect(slugOfRepoBranch("peso-web", "feat/points_mall3.0")).toBe("peso-web-feat-points_mall3.0");
    expect(slugOfRepoBranch("r", "a b/c")).toBe("r-a-b-c");
  });
});

describe("webhook 通知", () => {
  const entries: IndexEntry[] = [
    { repo: "demo", branch: "feat/a", counts: { critical: 1, high: 2, medium: 0, low: 0 }, fixed: 3, report: "r.md", prUrl: "https://pr/1" },
    { repo: "demo", branch: "feat/b", counts: {}, fixed: 0, report: "r2.md", error: "agent 超时" },
    { repo: "other", branch: "feat/c", counts: { high: 1 }, fixed: 0, report: "r3.md" },
  ];
  test("summarizeRepo 只聚合本仓库且累计计数", () => {
    const s = summarizeRepo("demo", entries);
    expect(s.branches).toBe(2);
    expect(s.fixed).toBe(3);
    expect(s.counts).toEqual({ critical: 1, high: 2, medium: 0, low: 0 });
    expect(s.prs).toEqual(["https://pr/1"]);
    expect(s.errors).toEqual(["agent 超时"]);
  });
  test("配置了 webhook 就 POST 摘要,空串不发请求", async () => {
    const got: unknown[] = [];
    const server = Bun.serve({ port: 0, fetch: async (req) => { got.push(await req.json()); return new Response("ok"); } });
    try {
      await notifyRepo({ ...cfg, notify: { webhook: `http://127.0.0.1:${server.port}/hook` } }, summarizeRepo("demo", entries));
      await notifyRepo(cfg, summarizeRepo("demo", entries)); // 默认空串:不发
    } finally { server.stop(true); }
    expect(got).toHaveLength(1);
    const body = got[0] as { msgtype: string; text: { content: string }; repo: string };
    expect(body.msgtype).toBe("text");
    expect(body.repo).toBe("demo");
    expect(body.text.content).toContain("ocv 审查完成：demo");
    expect(body.text.content).toContain("https://pr/1");
  });
});
