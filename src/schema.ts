/** 配置的唯一事实来源:zod schema。CLI 与 GUI 保存都走它,类型由它推导。 */
import { z } from "zod";

export const prKindSchema = z.enum(["gitee", "github", "manual"]);
export type PrKind = z.infer<typeof prKindSchema>;

export const severitySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof severitySchema>;
export const isSeverity = (v: unknown): v is Severity => severitySchema.safeParse(v).success;

export const repoCfgSchema = z.object({
  name: z.string(),
  path: z.string(),
  enabled: z.boolean().optional(),
  base: z.string().optional(),
  branches: z.string().optional(),
  pr: prKindSchema.optional(),
  maxBranches: z.number().int().positive().optional(),
});
export type RepoCfg = z.infer<typeof repoCfgSchema>;

export const configSchema = z.object({
  git: z.string().optional(),
  baseCandidates: z.array(z.string()).default(["origin/master", "origin/main"]),
  branches: z.string().default("feature*,feat*"),
  maxAgeDays: z.number().int().positive().default(14),
  maxBranches: z.number().int().positive().default(5),
  maxFiles: z.number().int().positive().default(40),
  concurrency: z.number().int().positive().default(2),
  reportInRepo: z.string().default(".code-review"),
  agent: z.object({
    bin: z.string().default("omp"),
    model: z.string().default(""),
    timeoutMinutes: z.number().int().positive().default(120),
    extraArgs: z.array(z.string()).default([]),
  }).prefault({}),
  pr: z.object({
    giteeTokenEnv: z.string().default("GITEE_TOKEN"),
    githubTokenEnv: z.string().default("GITHUB_TOKEN"),
  }).prefault({}),
  commit: z.object({
    name: z.string().default("ocv-bot"),
    email: z.string().default("ocv-bot@noreply.local"),
  }).prefault({}),
  /** 机器人 webhook:每跑完一个仓库 POST 一条 JSON 摘要;空串关闭 */
  notify: z.object({
    webhook: z.string().default(""),
  }).prefault({}),
  repos: z.array(repoCfgSchema).default([]),
});
export type Config = z.infer<typeof configSchema>;

/** GUI 展示用的配置视图:有效配置 + 各路径。type alias(而非 interface)以便赋给 Record<string, unknown> */
export type GuiConfig = Config & {
  _paths: { root: string; config: string; state: string; reports: string; run: string; worktrees: string };
};

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** giteeTokenEnv/githubTokenEnv 应填环境变量名;填了 token 本体是常见误用,直接报错而不是静默失效 */
export function assertTokenEnvNames(cfg: Config) {
  for (const [field, value] of [["pr.giteeTokenEnv", cfg.pr.giteeTokenEnv], ["pr.githubTokenEnv", cfg.pr.githubTokenEnv]] as const) {
    if (!ENV_NAME_RE.test(value)) {
      throw new Error(`${field} 应填环境变量名(如 GITEE_TOKEN),当前值看起来是 token 本体。把 token 放进 .ocv.secrets.json 或环境变量,配置里只留变量名。`);
    }
  }
}
