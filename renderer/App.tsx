import { useCallback, useEffect, useState } from "react";
import { Header } from "./components/Header";
import { RepoTable } from "./components/RepoTable";
import { Settings } from "./components/Settings";
import { RunPanel } from "./components/RunPanel";
import { StatusTable } from "./components/StatusTable";
import { SetupGuide } from "./components/SetupGuide";
import type { GuiConfig, State } from "./components/types";
import { stripPaths, useLog } from "./useOcv";

export function App() {
  const [config, setConfig] = useState<GuiConfig | null>(null);
  const [state, setState] = useState<State>({ branches: {} });
  const [running, setRunning] = useState(false);
  const [envError, setEnvError] = useState<{ bun: string; error: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const { log, ref: logRef, append, clear } = useLog();

  const loadConfig = useCallback(async () => {
    const cfg = await window.ocv.config();
    setConfig(cfg);
  }, []);

  const loadState = useCallback(async () => {
    setState(await window.ocv.state());
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const env = await window.ocv.checkEnv();
        if (!env.ok) {
          setEnvError({ bun: env.bun, error: env.error! });
          setChecking(false);
          return;
        }
        await loadConfig();
        await loadState();
        window.ocv.onDone(() => { setRunning(false); loadState(); });
        append("就绪。改完配置记得点「保存配置」；「试跑」只扫不改。");
      } catch (e) {
        append(`初始化失败: ${(e as Error).message}`);
      }
      setChecking(false);
    })();
  }, []);

  const saveConfig = async () => {
    if (!config) return;
    const res = await window.ocv.save(stripPaths(config));
    append(res.ok ? `配置已保存 → ${res.at}` : `保存失败：${res.error ?? ""}`);
  };

  const handleRun = async (args: string[]) => {
    clear();
    setRunning(true);
    const res = await window.ocv.run(args);
    if (!res.ok) {
      setRunning(false);
      append(res.error!);
    }
  };

  const handleCancel = async () => {
    const res = await window.ocv.cancel();
    append(res.ok ? "已发送中止信号。" : res.error!);
  };

  if (checking) return null;
  if (envError) return <SetupGuide bun={envError.bun} error={envError.error} />;
  if (!config) return null;

  return (
    <>
      <Header paths={config._paths ?? null} onSave={saveConfig} onLog={append} onSettings={() => setDrawer(true)} />
      <main>
        <RepoTable
          repos={config.repos ?? []}
          globalBranches={String(config.branches ?? "feature*,feat*")}
          onChange={(repos) => setConfig({ ...config, repos })}
        />
        {/* 编辑中的配置是未校验数据,保存时才过 zod;这里在类型边界显式转换 */}
        <Settings
          config={config as unknown as Record<string, unknown>}
          onChange={(c) => setConfig(c as unknown as GuiConfig)}
          open={drawer}
          onClose={() => setDrawer(false)}
        />
        <RunPanel log={log} logRef={logRef} running={running} onRun={handleRun} onCancel={handleCancel} />
        <StatusTable branches={state.branches} onRefresh={loadState} />
      </main>
    </>
  );
}
