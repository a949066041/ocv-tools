/** 配置/状态 IO + glob 工具。schema 校验见 schema.ts */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./types.js";
import { CONFIG_PATH } from "./paths.js";
import { assertTokenEnvNames, configSchema } from "./schema.js";

export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    die(`${path} 不是合法 JSON: ${(e as Error).message}`);
  }
}

/** 先写临时文件再 rename,避免并发/中断留下半截 JSON */
export function saveJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function loadConfig(): Config {
  const raw = loadJson<Record<string, unknown>>(CONFIG_PATH, {});
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    die(`配置文件校验失败:\n${result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const cfg = result.data as Config;
  try {
    assertTokenEnvNames(cfg);
  } catch (e) {
    die((e as Error).message);
  }
  return cfg;
}

/** glob -> regex,`*` 跨 `/` 匹配(与 git refspec 语义一致) */
export function globToRe(globs: string): RegExp {
  const parts = globs.split(",").map((g) => g.trim()).filter(Boolean)
    .map((g) => g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  return new RegExp(`^(?:${parts.join("|")})$`);
}
