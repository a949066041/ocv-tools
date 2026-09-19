/**
 * 配置加载与 JSON 持久化。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { ROOT, CONFIG_PATH } from "./constants";
import { die } from "./utils";

/** 只读自有配置文件/状态文件：形状由写入方保证，外部输入不走这里 */
export function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    die(`${path} 解析失败: ${(e as Error).message}`);
  }
}

export function saveJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function loadConfig(): Config {
  const raw = loadJson<Partial<Config>>(CONFIG_PATH, {});
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    agent: { ...DEFAULT_CONFIG.agent, ...raw.agent },
    pr: { ...DEFAULT_CONFIG.pr, ...raw.pr },
  };
}

/** Orca automation 起的 agent 拿不到交互 shell 里的 env，所以也认 .ocv.secrets.json */
export function secretValue(name: string): string | undefined {
  return process.env[name] ?? loadJson<Record<string, string>>(join(ROOT, ".ocv.secrets.json"), {})[name];
}