/** 测试共用:临时 git 仓库夹具 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function g(cwd: string, args: string[], env?: Record<string, string>): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "ocv-test-"));
}

/** bare origin(master) + clone 出的工作仓库,已配 user 信息 */
export function makeRepo(tmp: string): { origin: string; work: string } {
  const origin = join(tmp, "origin.git");
  g(tmp, ["init", "--bare", "-b", "master", origin]);
  const work = join(tmp, "work");
  g(tmp, ["clone", origin, work]);
  g(work, ["config", "user.email", "ocv@test"]);
  g(work, ["config", "user.name", "ocv test"]);
  return { origin, work };
}

export function commitAll(work: string, msg: string, env?: Record<string, string>): string {
  g(work, ["add", "-A"], env);
  g(work, ["commit", "-m", msg], env);
  return g(work, ["rev-parse", "HEAD"]);
}
