/** 数据根目录与派生路径。默认 ~/.ocv:开源仓库不落使用者配置/状态/token;OCV_ROOT 可覆盖(测试/打包版)。
 *  单独成文件:types.ts 要保持无 node 依赖,renderer 才能共享类型。 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
export const ROOT = process.env.OCV_ROOT ?? join(homedir(), ".ocv");
export const CONFIG_PATH = join(ROOT, "ocv.config.json");
export const STATE_PATH = join(ROOT, ".ocv-state.json");
export const SECRETS_PATH = join(ROOT, ".ocv.secrets.json");
export const WT_DIR = join(ROOT, ".wt");
export const RUN_DIR = join(ROOT, ".run");
export const REPORT_DIR = join(ROOT, "reports");

/** 一次性迁移:默认根下把旧的项目根数据抄过来(只抄不删,人工确认后再清);secrets 600、根目录 700 */
if (!process.env.OCV_ROOT) {
  mkdirSync(ROOT, { recursive: true });
  chmodSync(ROOT, 0o700);
  for (const f of ["ocv.config.json", ".ocv-state.json", ".ocv.secrets.json"]) {
    const from = join(REPO_ROOT, f);
    const to = join(ROOT, f);
    if (existsSync(from) && !existsSync(to)) {
      copyFileSync(from, to);
      if (f === ".ocv.secrets.json") chmodSync(to, 0o600);
    }
  }
}
