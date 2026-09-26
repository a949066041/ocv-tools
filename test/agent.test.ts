import "./setup-root.js";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrompt, resolveAgentBin, runAgent } from "../src/agent.js";
import { configSchema } from "../src/schema.js";
import type { Candidate } from "../src/types.js";
import { TEST_ROOT } from "./setup-root.js";

const candidate: Candidate = {
  repo: { name: "demo", path: "/tmp/demo" },
  branch: "feat/x", sha: "abcdef1234567890", mergeBase: "1234567890abcdef", commits: 3,
};

describe("buildPrompt", () => {
  const runDir = join(TEST_ROOT, "run");
  test("含关键路径与约束", () => {
    const p = buildPrompt(candidate, "origin/master", "ocr-review/feat-x", runDir);
    expect(p).toContain(join(runDir, "preview.json"));
    expect(p).toContain(join(runDir, "findings.json"));
    expect(p).toContain("merge-base 1234567890abcdef .. feat/x abcdef1234567890");
    expect(p).toContain("ocr delegate rule --repo /tmp/demo");
    expect(p).toContain("不要 push");
  });
});

describe("resolveAgentBin", () => {
  test("含路径的原样返回", () => {
    expect(resolveAgentBin("/x/y/agent")).toBe("/x/y/agent");
  });
  test("PATH 里找得到且跳过 node_modules/.bin", () => {
    const binDir = join(TEST_ROOT, "agentbin");
    mkdirSync(join(binDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(binDir, "node_modules", ".bin", "myagent"), "#!/bin/sh\nexit 9\n");
    writeFileSync(join(binDir, "myagent"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "myagent"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${join(binDir, "node_modules", ".bin")}:${binDir}:${oldPath}`;
    expect(resolveAgentBin("myagent")).toBe(join(binDir, "myagent"));
    process.env.PATH = oldPath;
  });
  test("找不到回落原名", () => {
    expect(resolveAgentBin("definitely-not-a-bin-xyz")).toBe("definitely-not-a-bin-xyz");
  });
});

describe("runAgent", () => {
  test("写 prompt/日志、透传退出码", async () => {
    const binDir = join(TEST_ROOT, "agentbin2");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "agent");
    writeFileSync(bin, '#!/bin/sh\necho "hello from agent $1"\nexit 7\n');
    chmodSync(bin, 0o755);
    const runDir = join(TEST_ROOT, "run-agent");
    mkdirSync(runDir, { recursive: true });
    const logPath = join(runDir, "log.txt");
    const cfg = configSchema.parse({ agent: { bin, timeoutMinutes: 1, model: "m1", extraArgs: ["--zz"] } });
    const code = await runAgent(cfg, "提示词内容", runDir, runDir, logPath, "tag");
    expect(code).toBe(7);
    expect(readFileSync(join(runDir, "prompt.txt"), "utf8")).toBe("提示词内容");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("--max-time 1m");
    expect(log).toContain("--model m1");
    expect(log).toContain("--zz");
    expect(log).toContain("hello from agent -p");
  });
  test("退出码 0 正常返回", async () => {
    const bin = join(TEST_ROOT, "agentbin2", "agent-ok");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    const runDir = join(TEST_ROOT, "run-agent-ok");
    mkdirSync(runDir, { recursive: true });
    const code = await runAgent(configSchema.parse({ agent: { bin } }), "p", runDir, runDir, join(runDir, "log.txt"), "t");
    expect(code).toBe(0);
    expect(existsSync(join(runDir, "log.txt"))).toBe(true);
  });
});
