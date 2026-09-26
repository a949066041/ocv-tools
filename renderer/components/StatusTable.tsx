import type { BranchState } from "./types";

interface Props {
  branches: Record<string, BranchState>;
  onRefresh: () => void;
}

export function StatusTable({ branches, onRefresh }: Props) {
  const entries = Object.entries(branches);

  return (
    <section className="panel wide">
      <div className="panel-head">
        <h2>最近状态</h2>
        <button onClick={onRefresh}>刷新</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>仓库</th><th>分支</th><th>crit / high</th><th>med / low</th><th>PR / 错误</th><th>最近运行</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan={6} className="muted">还没有跑过任何分支</td></tr>
            )}
            {entries.map(([key, b]) => {
              const [repo, branch] = key.split("|");
              const c = b.counts ?? {};
              return (
                <tr key={key}>
                  <td>{repo}</td>
                  <td>{branch}</td>
                  <td>{c.critical ?? 0} / {c.high ?? 0}</td>
                  <td>{c.medium ?? 0} / {c.low ?? 0}</td>
                  <td>
                    {b.prUrl ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); window.ocv.open(b.prUrl!); }}>打开 PR</a>
                    ) : b.error ? (
                      <span className="err">{b.error}</span>
                    ) : b.note ? (
                      <span className="muted">{b.note}</span>
                    ) : (
                      <span className="muted">无</span>
                    )}
                  </td>
                  <td className="muted">{(b.reviewedAt ?? "").slice(0, 19).replace("T", " ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
