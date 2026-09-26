import { useEffect, useRef, useState } from "react";

interface Props {
  log: string;
  logRef: React.RefObject<HTMLPreElement | null>;
  running: boolean;
  onRun: (args: string[]) => void;
  onCancel: () => void;
}

export function RunPanel({ log, logRef, running, onRun, onCancel }: Props) {
  const repoRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLInputElement>(null);
  const forceRef = useRef<HTMLInputElement>(null);
  const [awake, setAwake] = useState(false);
  useEffect(() => { window.ocv.keepAwake().then(setAwake); }, []);
  const toggleAwake = async () => setAwake(await window.ocv.keepAwake(!awake));

  const buildArgs = (extra: string[]) => {
    const args = [...extra];
    const repo = repoRef.current?.value.trim();
    const branch = branchRef.current?.value.trim();
    if (repo) args.push("--repo", repo);
    if (branch) args.push("--branch", branch);
    if (forceRef.current?.checked) args.push("--force");
    return args;
  };

  return (
    <section className="panel wide">
      <div className="panel-head">
        <h2>运行 {running && <span className="tag">运行中…</span>}</h2>
        <div className="actions">
          <input ref={repoRef} placeholder="仓库过滤 (glob)" />
          <input ref={branchRef} placeholder="分支过滤 (glob)" />
          <label className="chk"><input type="checkbox" ref={forceRef} /> 强制重跑</label>
          <button className={awake ? "primary" : ""} title="运行期间阻止系统休眠/合盖挂起,保证夜间任务不被冻住" onClick={toggleAwake}>{awake ? "防休眠：开" : "防休眠：关"}</button>
          <button disabled={running} onClick={() => onRun(buildArgs(["--dry-run"]))}>试跑（dry-run）</button>
          <button className="primary" disabled={running} onClick={() => {
            if (!confirm("立即运行会真实推修复分支并尝试创建 PR，继续？")) return;
            onRun(buildArgs([]));
          }}>立即运行</button>
          <button className="danger" onClick={onCancel}>中止</button>
        </div>
      </div>
      <pre ref={logRef}>{log}</pre>
    </section>
  );
}
