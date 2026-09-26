import { AppUpdate } from "./AppUpdate";
import { OcrGuide } from "./OcrGuide";

interface Props {
  paths: { config: string; reports: string } | null;
  onSave: () => void;
  onLog: (text: string) => void;
  onSettings: () => void;
}

export function Header({ paths, onSave, onLog, onSettings }: Props) {
  return (
    <header>
      <div className="brand">
        <img className="logo" src="./logo.png" alt="ocv logo" />
        <div>
          <h1>ocv 控制台</h1>
        {paths && (
          <p className="sub">
            配置 {paths.config} · 报告 {paths.reports}
          </p>
        )}
      </div>
      </div>
      <div className="actions">
        <AppUpdate />
        <button onClick={onSettings}>全局设置</button>
        <OcrGuide onLog={onLog} />
        <button className="primary" onClick={onSave}>保存配置</button>
        <button onClick={() => window.ocv.open("reports")}>报告目录</button>
      </div>
    </header>
  );
}
