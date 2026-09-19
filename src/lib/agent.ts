/**
 * 无头 agent（omp）调度：构建 prompt、启动子进程、收集输出。
 */
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "./types";
import type { Config } from "./types";
import { WT_DIR } from "./constants";
import { childEnv } from "./git";
import { slugOfRepoBranch } from "./utils";

/**
 * `bun run` 会把沿途各层 node_modules/.bin 塞进 PATH，$HOME/node_modules/.bin/omp 之类
 * 的旧 shim 会盖掉真正的 agent 可执行文件。挑 agent 时跳过这些 .bin 目录。
 */
export function resolveAgentBin(name: string): string {
  if (name.includes("/")) return name;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir || dir.includes("node_modules")) continue;
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return name;
}

export function buildPrompt(c: Candidate, base: string, fixBranch: string, runDir: string): string {
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

export async function runAgent(
  cfg: Config, prompt: string, workdir: string, runDir: string, logPath: string, tag: string,
): Promise<number> {
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