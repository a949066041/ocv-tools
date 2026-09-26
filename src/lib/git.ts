/**
 * Git 操作封装。管理 git 二进制路径解析和子进程环境。
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import type { Config } from "./types";
import { ROOT } from "./constants";
import { die } from "./utils";

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
export function resolveGit(cfg: Config): void {
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
export function childEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (GIT_DIR) env.PATH = `${GIT_DIR}:${env.PATH ?? ""}`;
  return env;
}

export interface ExecResult { code: number; out: string; err: string }

export async function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
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

export async function git(args: string[], cwd: string): Promise<string> {
  const r = await sh(GIT, args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失败: ${r.err || r.out}`);
  return r.out;
}

export async function gitOrNull(args: string[], cwd: string): Promise<string | null> {
  const r = await sh(GIT, args, { cwd });
  return r.code === 0 ? r.out : null;
}