import { useEffect, useRef, useState } from "react";
import type { PrKind, RepoCfg } from "./types";

interface Props {
  repos: RepoCfg[];
  globalBranches: string;
  onChange: (repos: RepoCfg[]) => void;
}

/** 分支匹配两种模式:多选(勾远端分支,存成逗号 glob)与手动(直接写 glob/正则串)。
 *  存储格式不变(branches 字符串),CLI 语义零改动。 */
function BranchPicker({ value, placeholder, repoPath, onChange }: {
  value: string; placeholder: string; repoPath: string; onChange: (v: string | undefined) => void;
}) {
  const [mode, setMode] = useState<"pick" | "manual">("pick");
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
  // 含 glob 通配/正则字符的值不是多选能表达的,自动落到手动模式
  const hasWild = selected.some((s) => /[*?[\](){}|^+$\\]/.test(s));
  const effective = mode === "pick" && hasWild ? "manual" : mode;
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    window.ocv.branches(repoPath).then((b) => { setList(b); setLoading(false); });
  }, [open, repoPath]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    // 表格容器 overflow 会裁掉弹层:fixed 定位跟触发按钮对齐,滚动即收
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("scroll", onScroll, true); };
  }, [open]);

  const toggle = (b: string) => {
    const next = selected.includes(b) ? selected.filter((s) => s !== b) : [...selected, b];
    onChange(next.length ? next.join(",") : undefined);
  };

  return (
    <div className="branch-box" ref={boxRef}>
      {effective === "pick" ? (
        <>
          <button className="branch-trigger" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPos({ top: r.bottom + 4, left: r.left });
            setOpen(!open);
          }}>
            {selected.length ? selected.join(", ") : <span className="muted">全部（{placeholder}）</span>}
          </button>
          {open && (
            <div className="branch-pop" style={{ top: pos.top, left: pos.left }}>
              {loading && <div className="muted">读取远端分支…</div>}
              {!loading && list.length === 0 && <div className="muted">读不到远端分支,切「手动」直接写</div>}
              {list.map((b) => (
                <label className="chk" key={b}>
                  <input type="checkbox" checked={selected.includes(b)} onChange={() => toggle(b)} /> {b}
                </label>
              ))}
            </div>
          )}
        </>
      ) : (
        <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value || undefined)} />
      )}
      <button className="icon-btn" title={effective === "pick" ? "切到手动输入 glob/正则" : "切到多选"}
        onClick={() => setMode(effective === "pick" ? "manual" : "pick")}>
        {effective === "pick" ? "✎" : "☑"}
      </button>
    </div>
  );
}

export function RepoTable({ repos, globalBranches, onChange }: Props) {
  const add = async () => {
    const folder = await window.ocv.pickFolder();
    if (!folder) return;
    const name = folder.split("/").pop() ?? "new-repo";
    onChange([...repos, { name, path: folder, pr: "manual", enabled: true }]);
  };

  const browse = async (i: number) => {
    const folder = await window.ocv.pickFolder();
    if (!folder) return;
    const name = repos[i].name === "new-repo" || !repos[i].name
      ? folder.split("/").pop() ?? repos[i].name
      : repos[i].name;
    onChange(repos.map((r, idx) => (idx === i ? { ...r, path: folder, name } : r)));
  };

  const del = (i: number) => onChange(repos.filter((_, idx) => idx !== i));
  const set = (i: number, key: keyof RepoCfg, value: unknown) =>
    onChange(repos.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));

  return (
    <section className="panel wide">
      <div className="panel-head">
        <h2>仓库 <span className="count">{repos.length} 个</span></h2>
        <button onClick={add}>＋ 添加仓库</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th><th>名称</th><th>路径</th><th>基线</th><th>分支匹配</th><th>PR 平台</th><th></th>
            </tr>
          </thead>
          <tbody>
            {repos.length === 0 && (
              <tr><td colSpan={7} className="muted">还没有仓库，点「添加仓库」选择一个 git 目录</td></tr>
            )}
            {repos.map((r, i) => (
              <tr key={i}>
                <td className="on">
                  <input type="checkbox" checked={r.enabled !== false} onChange={(e) => set(i, "enabled", e.target.checked)} />
                </td>
                <td className="name">
                  <input value={r.name} onChange={(e) => set(i, "name", e.target.value)} />
                </td>
                <td className="path">
                  <span className="path-cell">
                    <input value={r.path} onChange={(e) => set(i, "path", e.target.value)} placeholder="点击右侧选择目录" />
                    <button className="icon-btn" title="选择目录" onClick={() => browse(i)}>📁</button>
                  </span>
                </td>
                <td className="base">
                  <input value={r.base ?? ""} placeholder="自动探测" onChange={(e) => set(i, "base", e.target.value || undefined)} />
                </td>
                <td className="pat">
                  <BranchPicker value={r.branches ?? ""} placeholder={globalBranches} repoPath={r.path} onChange={(v) => set(i, "branches", v)} />
                </td>
                <td className="pr">
                  <select value={r.pr ?? "manual"} onChange={(e) => set(i, "pr", e.target.value as PrKind)}>
                    <option value="gitee">gitee</option>
                    <option value="github">github</option>
                    <option value="manual">manual</option>
                  </select>
                </td>
                <td className="del">
                  <button onClick={() => del(i)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
