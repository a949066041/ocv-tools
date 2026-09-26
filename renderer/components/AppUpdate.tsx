import { useEffect, useState } from "react";

/** 右上角 ocv 自身更新提示:打包版对比 GitHub Releases,落后时给「查看更新」按钮 */
export function AppUpdate() {
  const [info, setInfo] = useState<{ current: string; latest: string; url: string } | null>(null);

  useEffect(() => { window.ocv.updateCheck().then(setInfo); }, []);

  if (!info || !info.latest || info.latest === info.current) {
    return info ? <span className="ocr-badge ok">ocv v{info.current}</span> : null;
  }
  return (
    <span className="ocr-guide">
      <span className="ocr-badge warn">ocv v{info.current} → v{info.latest}</span>
      <button className="primary" onClick={() => window.ocv.open(info.url)}>查看更新</button>
    </span>
  );
}
