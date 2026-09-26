import "./setup-root.js";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv, git, gitOrNull, resolveGit, sh, GIT, GIT_DIR } from "../src/git.js";
import { configSchema } from "../src/schema.js";
import { TEST_ROOT } from "./setup-root.js";

function fakeGit(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "git");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\nexec /usr/bin/git "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("resolveGit", () => {
  test("挑版本最高的候选", () => {
    const oldBin = fakeGit(join(TEST_ROOT, "git-old"), "99.0.1");
    const newBin = fakeGit(join(TEST_ROOT, "git-new"), "99.1.0");
    resolveGit(configSchema.parse({ git: oldBin }));
    expect(GIT).toBe(oldBin); // 只有它一个候选时就用它
    process.env.OCV_GIT = newBin;
    resolveGit(configSchema.parse({ git: oldBin }));
    expect(GIT).toBe(newBin);
    expect(GIT_DIR).toBe(join(TEST_ROOT, "git-new"));
    delete process.env.OCV_GIT;
  });
  test("cfg.git 版本更高时赢过 OCV_GIT", () => {
    const oldBin = fakeGit(join(TEST_ROOT, "git-old2"), "99.0.2");
    const newBin = fakeGit(join(TEST_ROOT, "git-new2"), "99.2.0");
    process.env.OCV_GIT = oldBin;
    resolveGit(configSchema.parse({ git: newBin }));
    expect(GIT).toBe(newBin);
    delete process.env.OCV_GIT;
  });
});

describe("childEnv", () => {
  test("GIT_DIR 前置进 PATH", () => {
    resolveGit(configSchema.parse({ git: fakeGit(join(TEST_ROOT, "git-env"), "99.3.0") }));
    expect(childEnv().PATH!.startsWith(GIT_DIR)).toBe(true);
  });
});

describe("sh / git / gitOrNull", () => {
  test("sh 收 stdout/stderr/退出码", async () => {
    const r = await sh("sh", ["-c", "echo out; echo err >&2; exit 3"]);
    expect(r).toMatchObject({ code: 3, out: "out", err: "err" });
  });
  test("git 成功返回去空白输出", async () => {
    const out = await git(["--version"], TEST_ROOT);
    expect(out).toMatch(/^git version/);
  });
  test("git 失败抛带命令与 stderr 的错", async () => {
    await expect(git(["rev-parse", "--verify", "no-such-ref"], TEST_ROOT)).rejects.toThrow(/git rev-parse --verify no-such-ref 失败/);
  });
  test("gitOrNull 失败返回 null", async () => {
    expect(await gitOrNull(["rev-parse", "--verify", "no-such-ref"], TEST_ROOT)).toBeNull();
  });
});
