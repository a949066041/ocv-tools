import { useCallback, useEffect, useState } from "react";

interface Props {
  onLog: (text: string) => void;
}

/** 右上角 OCR 引导:未安装→安装,落后→更新,最新→绿色徽标。安装输出实时转发到日志面板 */
export function OcrGuide({ onLog }: Props) {
  const [info, setInfo] = useState<{ installed: string | null; latest: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => setInfo(await window.ocv.ocrCheck()), []);
  useEffect(() => { check(); }, [check]);

  const install = async () => {
    setBusy(true);
    const res = await window.ocv.ocrInstall();
    setBusy(false);
    onLog(res.ok ? "\nocr 安装/更新完成。\n" : `\n${res.error}\n`);
    await check();
  };

  if (!info) return <span className="ocr-badge">OCR 检测中…</span>;
  if (info.installed === null) {
    return (
      <span className="ocr-guide">
        <span className="ocr-badge warn">OCR 未安装</span>
        <button className="primary" disabled={busy} onClick={install}>{busy ? "安装中…" : "安装 OCR"}</button>
      </span>
    );
  }
  if (info.latest && info.installed !== info.latest) {
    return (
      <span className="ocr-guide">
        <span className="ocr-badge warn">OCR v{info.installed} → v{info.latest}</span>
        <button className="primary" disabled={busy} onClick={install}>{busy ? "更新中…" : "更新 OCR"}</button>
      </span>
    );
  }
  return <span className="ocr-badge ok">OCR v{info.installed} 已是最新</span>;
}
