/** preload.js 暴露到 window.ocv 的接口 */
import type { GuiConfig, State } from "./components/types";

interface OcvBridge {
  config: () => Promise<GuiConfig>;
  save: (cfg: unknown) => Promise<{ ok: boolean; at?: string; error?: string }>;
  state: () => Promise<State>;
  run: (args: string[]) => Promise<{ ok: boolean; error?: string }>;
  cancel: () => Promise<{ ok: boolean; error?: string }>;
  open: (what: string) => Promise<void>;
  pickFolder: () => Promise<string | null>;
  checkEnv: () => Promise<{ ok: boolean; bun: string; bunVersion?: string; error?: string }>;
  ocrCheck: () => Promise<{ installed: string | null; latest: string }>;
  ocrInstall: () => Promise<{ ok: boolean; error?: string }>;
  updateCheck: () => Promise<{ current: string; latest: string; url: string }>;
  keepAwake: (on?: boolean) => Promise<boolean>;
  branches: (repoPath: string) => Promise<string[]>;
  onOutput: (cb: (text: string) => void) => void;
  onDone: (cb: (code: number) => void) => void;
}

declare global {
  interface Window {
    ocv: OcvBridge;
  }
}

export {};
