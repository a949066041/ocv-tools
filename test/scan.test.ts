import "./setup-root.js";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configSchema } from "../src/schema.js";
import { pickBase, scanRepo } from "../src/scan.js";
import type { Config, State } from "../src/types.js";
import { commitAll, g, makeRepo, tmpRoot } from "./helpers.js";

const OLD = { GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" };

function setup() {
  const tmp = tmpRoot();
  const { work } = makeRepo(tmp);
  writeFileSync(join(work, "a.txt"), "base\n");
  commitAll(work, "init");
  g(work, ["push", "origin", "master"]);

  writeFileSync(join(work, "a.txt"), "fresh-a\n");
  g(work, ["checkout", "-b", "feat/a"]);
  const shaA = commitAll(work, "feat a");
  g(work, ["push", "origin", "feat/a"]);

  g(work, ["checkout", "-b", "feat/b", "master"]);
  writeFileSync(join(work, "b.txt"), "fresh-b\n");
  const shaB = commitAll(work, "feat b");
  g(work, ["push", "origin", "feat/b"]);

  g(work, ["checkout", "-b", "feat/stale", "master"]);
  writeFileSync(join(work, "s.txt"), "stale\n");
  commitAll(work, "stale", OLD);
  g(work, ["push", "origin", "feat/stale"]);

  g(work, ["branch", "feat/same", "master"]);
  g(work, ["push", "origin", "feat/same"]);
  g(work, ["checkout", "master"]);
  return { tmp, work, shaA, shaB, cfg: configSchema.parse({ maxBranches: 5 }) as Config };
}

describe("scanRepo", () => {
  test("筛选:glob 匹配、时间、sha 去重、merge-base、maxBranches", async () => {
    const { work, shaB, cfg } = setup();
    const repo = { name: "demo", path: work };
    const state: State = { branches: { "demo|feat/b": { sha: shaB, reviewedAt: "2026-01-01T00:00:00Z" } } };

    const first = await scanRepo(cfg, { branches: {} }, repo, { force: false });
    expect(first.candidates.map((c) => c.branch).sort()).toEqual(["feat/a", "feat/b"]);
    expect(first.skipped.join("\n")).toContain("feat/stale (14 天无提交)");
    expect(first.skipped.join("\n")).toContain("feat/same (相对 origin/master 无新提交)");
    const a = first.candidates.find((c) => c.branch === "feat/a")!;
    expect(a.commits).toBe(1);
    expect(a.mergeBase).toMatch(/^[0-9a-f]{40}$/);

    // state 里同 sha 的分支跳过;force 则不跳
    const second = await scanRepo(cfg, state, repo, { force: false });
    expect(second.candidates.map((c) => c.branch)).toEqual(["feat/a"]);
    expect(second.skipped.join("\n")).toContain("feat/b (与上次审查同一提交)");
    const forced = await scanRepo(cfg, state, repo, { force: true });
    expect(forced.candidates).toHaveLength(2);

    // maxBranches 截断,按最新提交优先
    const capped = await scanRepo({ ...cfg, maxBranches: 1 }, { branches: {} }, repo, { force: false });
    expect(capped.candidates).toHaveLength(1);
    expect(capped.skipped.join("\n")).toContain("超出 maxBranches=1");
  });

  test("branchFilter 只留匹配分支", async () => {
    const { work, cfg } = setup();
    const r = await scanRepo(cfg, { branches: {} }, { name: "demo", path: work }, { force: false, branchFilter: /^feat\/a$/ });
    expect(r.candidates.map((c) => c.branch)).toEqual(["feat/a"]);
  });
});

describe("pickBase", () => {
  test("repo.base 不存在时回落 baseCandidates,全不存在才抛错", async () => {
    const { work, cfg } = setup();
    expect(await pickBase(cfg, { name: "demo", path: work, base: "origin/nope" })).toBe("origin/master");
    await expect(pickBase({ ...cfg, baseCandidates: ["origin/nope"] }, { name: "demo", path: work })).rejects.toThrow(/找不到基线分支/);
  });
});
