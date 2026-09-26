import { useState } from "react";

interface Props {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  open: boolean;
  onClose: () => void;
}

function kindOf(v: unknown): "num" | "bool" | "list" | "str" {
  if (typeof v === "number") return "num";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return "list";
  return "str";
}

/** 配置项中文名:界面按 key 取,取不到回落到原始 key(新增字段不会变成空白标签) */
const LABELS: Record<string, string> = {
  git: "git 可执行文件",
  baseCandidates: "基线分支候选",
  branches: "分支匹配",
  maxAgeDays: "最长提交天数",
  maxBranches: "最多审查分支数",
  maxFiles: "单分支最多改动文件",
  concurrency: "并发 agent 数",
  reportInRepo: "仓库内报告目录",
  "agent.bin": "agent 可执行文件",
  "agent.model": "模型",
  "agent.timeoutMinutes": "超时(分钟)",
  "agent.extraArgs": "附加参数",
  "pr.giteeTokenEnv": "Gitee token 变量名",
  "commit.name": "提交机器人名称",
  "commit.email": "提交机器人邮箱",
  "notify.webhook": "机器人 Webhook",
};
const GROUPS: Record<string, string> = { agent: "Agent 审查", pr: "PR 平台", commit: "提交署名", notify: "通知" };

function Field({ path, kind, value, label, onChange }: {
  path: string; kind: string; value: unknown; label: string;
  onChange: (path: string, value: unknown) => void;
}) {
  // 数字输入框用本地文本态：清空时不能把 NaN 写进配置（zod 会拒），留空 = 删除该键用默认值
  const [text, setText] = useState(value === undefined ? "" : String(value));
  if (kind === "bool") {
    return (
      <div className="field">
        <label>{label}</label>
        <label className="chk">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(path, e.target.checked)} /> 启用
        </label>
      </div>
    );
  }
  const shown = kind === "list" ? (value as unknown[] ?? []).join(", ") : kind === "num" ? text : String(value ?? "");
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type={kind === "num" ? "number" : "text"}
        value={shown}
        onChange={(e) => {
          const v = e.target.value;
          if (kind === "num") {
            setText(v);
            onChange(path, v.trim() === "" ? undefined : Number(v));
          } else if (kind === "list") onChange(path, v.split(",").map((s) => s.trim()).filter(Boolean));
          else onChange(path, v);
        }}
      />
    </div>
  );
}

/** 按路径设置嵌套对象的值;value 为 undefined 时删除该键(回落到 schema 默认值) */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".");
  const next = { ...obj };
  let node: Record<string, unknown> = next;
  for (const p of parts.slice(0, -1)) {
    const child = { ...(node[p] as Record<string, unknown> ?? {}) };
    node[p] = child;
    node = child;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return next;
}

export function Settings({ config, onChange, open, onClose }: Props) {
  const entries = Object.entries(config).filter(([k]) => !k.startsWith("_") && k !== "repos");

  return (
    <>
      <div className={`drawer-scrim ${open ? "show" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "show" : ""}`}>
        <div className="panel-head"><h2>全局设置</h2><button onClick={onClose}>关闭</button></div>
      <div className="settings">
        {entries.map(([k, v]) => {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            return (
              <div key={k}>
                <div className="group">{GROUPS[k] ?? k}</div>
                {Object.entries(v as Record<string, unknown>).map(([sk, sv]) => (
                  <Field
                    key={`${k}.${sk}`}
                    path={`${k}.${sk}`}
                    kind={kindOf(sv)}
                    value={sv}
                    label={LABELS[`${k}.${sk}`] ?? sk}
                    onChange={(p, val) => onChange(setByPath(config, p, val))}
                  />
                ))}
              </div>
            );
          }
          if (v === undefined) return null;
          return (
            <Field
              key={k}
              path={k}
              kind={kindOf(v)}
              value={v}
              label={LABELS[k] ?? k}
              onChange={(p, val) => onChange(setByPath(config, p, val))}
            />
          );
        })}
      </div>
      </aside>
    </>
  );
}
