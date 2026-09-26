/** remote 解析 + PR 创建 */
import type { Config, PrKind, RepoCfg } from "./types.js";
import { SECRETS_PATH } from "./paths.js";
import { loadJson } from "./config.js";

export function parseRemote(url: string): { host: string; owner: string; repo: string } | null {
  const u = url.trim();
  if (u.startsWith("/") || u.startsWith(".") || u.startsWith("file://")) {
    const repo = u.replace(/^file:\/\//, "").replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "");
    return repo ? { host: "local", owner: "", repo } : null;
  }
  const m = /^(?:git@|https?:\/\/)([^:/]+)[:/](.+?)(?:\.git)?$/.exec(u);
  if (!m) return null;
  const segs = m[2].split("/");
  const repo = segs.pop()!;
  return { host: m[1], owner: segs.join("/"), repo };
}

export function prKindFor(host: string, repo: RepoCfg): PrKind {
  if (repo.pr) return repo.pr;
  if (host.includes("gitee.com")) return "gitee";
  if (host.includes("github.com")) return "github";
  return "manual";
}

export interface PrResult { url: string; note?: string }

interface PrApiResponse { html_url?: unknown; error?: unknown; message?: unknown }

/** Orca automation 起的 agent 拿不到交互 shell 的 env，所以也认 .ocv.secrets.json */
function prToken(cfg: Config, kind: "gitee" | "github"): string | undefined {
  const name = kind === "gitee" ? cfg.pr.giteeTokenEnv : cfg.pr.githubTokenEnv;
  return process.env[name] ?? loadJson<Record<string, string>>(SECRETS_PATH, {})[name];
}

/** 所有失败路径都降级到手动链接，不阻塞后续分支的审查 */
export async function createPr(
  kind: PrKind, remote: { host: string; owner: string; repo: string }, cfg: Config,
  fixBranch: string, baseBranch: string, title: string, body: string,
): Promise<PrResult> {
  if (remote.host === "local") return { url: "", note: "本地 remote：分支已推送，无 PR 平台可提交" };
  // 手动链接兜底：即使 API 调不通，用户也能点链接自己建 PR
  const manualUrl = kind === "gitee"
    ? `https://gitee.com/${remote.owner}/${remote.repo}/compare/${baseBranch}...${fixBranch}`
    : `https://${remote.host}/${remote.owner}/${remote.repo}/compare/${baseBranch}...${fixBranch}?expand=1`;

  if (kind === "manual") return { url: manualUrl, note: "该平台未接 API：分支已推送，请打开链接手动创建 PR" };
  const token = prToken(cfg, kind);
  if (!token) {
    const envName = kind === "gitee" ? cfg.pr.giteeTokenEnv : cfg.pr.githubTokenEnv;
    return { url: manualUrl, note: `缺少 ${envName}（可写进 ${SECRETS_PATH}）：分支已推送，请手动创建 PR` };
  }

  // OCV_GITEE_API/OCV_GITHUB_API:测试指向本地 mock,生产走默认
  const giteeApi = process.env.OCV_GITEE_API ?? "https://gitee.com/api/v5";
  const githubApi = process.env.OCV_GITHUB_API ?? "https://api.github.com";
  const [api, headers, payload] = kind === "gitee"
    ? [`${giteeApi}/repos/${remote.owner}/${remote.repo}/pulls`,
       { "Content-Type": "application/json" },
       { access_token: token, title, head: fixBranch, base: baseBranch, body }]
    : [`${githubApi}/repos/${remote.owner}/${remote.repo}/pulls`,
       { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
       { title, head: fixBranch, base: baseBranch, body }];

  try {
    const res = await fetch(api, { method: "POST", headers, body: JSON.stringify(payload) });
    const j = (await res.json()) as PrApiResponse;
    if (!res.ok) {
      const why = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
      return { url: manualUrl, note: `${kind} PR 创建失败(${res.status}): ${why}` };
    }
    return { url: typeof j.html_url === "string" ? j.html_url : manualUrl };
  } catch (e) {
    return { url: manualUrl, note: `创建 PR 异常: ${(e as Error).message}` };
  }
}
