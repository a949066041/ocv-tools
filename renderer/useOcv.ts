import { useCallback, useEffect, useRef, useState } from "react";

/** 从配置对象中去掉只读的 _paths 字段 */
export function stripPaths(cfg: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith("_")));
}

/** 日志 append hook：监听 ocv:out 事件 */
export function useLog() {
  const [log, setLog] = useState("");
  const ref = useRef<HTMLPreElement>(null);

  const append = useCallback((text: string) => {
    setLog((prev) => prev + text);
    // 滚动到底部
    requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
  }, []);

  const clear = useCallback(() => setLog(""), []);

  useEffect(() => {
    window.ocv.onOutput((text) => append(text));
    window.ocv.onDone(() => append("\n"));
  }, [append]);

  return { log, ref, append, clear };
}
