/** 必须在任何 src 模块之前 import:paths.ts 在加载时读 OCV_ROOT,
 *  测试先把它指向临时目录,避免碰项目真实配置/状态/secrets。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_ROOT = mkdtempSync(join(tmpdir(), "ocv-root-"));
process.env.OCV_ROOT = TEST_ROOT;
