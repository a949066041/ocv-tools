import "./setup-root.js";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, STATE_PATH } from "../src/paths.js";
import { TEST_ROOT } from "./setup-root.js";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

// 假 ocr:让 run 的 preflight 不依赖机器上是否装了真 ocr
const binDir = join(TEST_ROOT, "cli-bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "ocr"), "#!/bin/sh\necho open-code-review fake\nexit 0\n");
chmodSync(join(binDir, "ocr"), 0o755);

function run(args: string[], stdinFile?: string) {
  return Bun.spawnSync(["bun", CLI, ...args], {
    cwd: TEST_ROOT,
    env: { ...process.env, OCV_ROOT: TEST_ROOT, PATH: `${binDir}:${process.env.PATH}` },
    stdin: stdinFile ? Bun.file(stdinFile) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdinFile(name: string, content: string): string {
  const p = join(TEST_ROOT, name);
  writeFileSync(p, content);
  return p;
}

describe("cli 入口", () => {
  test("help 输出用法", () => {
    const r = run(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("ocv run");
    expect(r.stdout.toString()).toContain("ocv save-config");
  });

  test("未知 flag 直接报错(strict)", () => {
    expect(run(["status", "--nope"]).exitCode).not.toBe(0);
  });

  test("未知命令报错", () => {
    const r = run(["frobnicate"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("未知命令");
  });

  test("config 输出带 _paths 且 root 为 OCV_ROOT", () => {
    const r = run(["config"]);
    expect(r.exitCode).toBe(0);
    const json = JSON.parse(r.stdout.toString());
    expect(json._paths.root).toBe(TEST_ROOT);
    expect(json.branches).toBe("feature*,feat*");
  });

  test("save-config 落默认值", () => {
    const r = run(["save-config"], stdinFile("in-empty.json", "{}"));
    expect(r.exitCode).toBe(0);
    const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(saved.branches).toBe("feature*,feat*");
    expect(saved.agent.bin).toBe("omp");
  });

  test("status 空状态有引导文案", () => {
    writeFileSync(STATE_PATH, JSON.stringify({ branches: {} }));
    const r = run(["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("还没有跑过任何分支");
  });

  test("status 状态文件损坏时报错退出", () => {
    writeFileSync(STATE_PATH, "{oops");
    const r = run(["status"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("不是合法 JSON");
    writeFileSync(STATE_PATH, JSON.stringify({ branches: {} }));
  });

  test("add 校验:非 git 目录拒收、重复名拒收、remove 生效", () => {
    const notGit = join(TEST_ROOT, "notgit");
    mkdirSync(notGit, { recursive: true });
    expect(run(["add", notGit]).exitCode).not.toBe(0);

    const repo = join(TEST_ROOT, "repo");
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    expect(run(["add", repo, "--name", "demo"]).exitCode).toBe(0);
    expect(run(["add", repo, "--name", "demo"]).exitCode).not.toBe(0);
    expect(run(["remove", "demo"]).exitCode).toBe(0);
    expect(run(["remove", "demo"]).exitCode).not.toBe(0);
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(cfg.repos).toEqual([]);
  });

  test("run 无匹配仓库时报错", () => {
    const r = run(["run", "--dry-run"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("没有匹配的仓库");
  });

  test("--concurrency 非正整数报错", () => {
    const r = run(["run", "--concurrency", "0"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("--concurrency");
  });

  test("配置文件损坏时 loadConfig 报错", () => {
    writeFileSync(CONFIG_PATH, "{broken");
    const r = run(["status"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("不是合法 JSON");
    writeFileSync(CONFIG_PATH, "{}");
  });

  test("token 本体写进配置时 loadConfig 报错", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ pr: { giteeTokenEnv: "64dbfccfa767a89d7a740932e57ccf62" } }));
    const r = run(["status"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("环境变量名");
    writeFileSync(CONFIG_PATH, "{}");
  });

  test("OCV_ROOT 隔离:不碰项目真实配置", () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
    expect(CONFIG_PATH.startsWith(TEST_ROOT)).toBe(true);
  });
});
