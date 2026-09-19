/**
 * Remote 解析与 PR 创建（Gitee / GitHub）。
 */
import type { Config, PrKind, RepoCfg } from "./types";
import { secretValue } from "./config";

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

/** PR 接口响应只需要这三个字段；类型不符一律当缺省，不猜其余结构 */
interface PrApiResponse { html_url?: unknown; error?: unknown; message?: unknown }

export async function createPr(
  kind: PrKind, remote: { host: string; owner: string; repo: string }, cfg: Config,
  fixBranch: string, baseBranch: string, title: string, body: string,
): Promise<PrResult> {
  if (remote.host === "local") return { url: "", note: "本地 remote：分支已推送，无 PR 平台可提交" };
  const manualUrl = kind === "gitee"
    ? `https://gitee.com/${remote.owner}/${remote.repo}/compare/${baseBranch}...${fixBranch}`
    : `https://${remote.host}/${remote.owner}/${remote.repo}/compare/${baseBranch}...${fixBranch}?expand=1`;

  if (kind === "manual") return { url: manualUrl, note: "该平台未接 API：分支已推送，请打开链接手动创建 PR" };
  const token = secretValue(kind === "gitee" ? cfg.pr.giteeTokenEnv : cfg.pr.githubTokenEnv);
  if (!token) {
    const envName = kind === "gitee" ? cfg.pr.giteeTokenEnv : cfg.pr.githubTokenEnv;
    return { url: manualUrl, note: `缺少 ${envName}（可写进 .ocv.secrets.json）：分支已推送，请手动创建 PR` };
  }

  const [api, headers, payload] = kind === "gitee"
    ? [`https://gitee.com/api/v5/repos/${remote.owner}/${remote.repo}/pulls`,
       { "Content-Type": "application/json" },
       { access_token: token, title, head: fixBranch, base: baseBranch, body }]
    : [`https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`,
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