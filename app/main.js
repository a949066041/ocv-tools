// Electron 主进程：只做三件事——读写配置、跑 ocv CLI 并转发输出、把状态读给界面。
// 业务规则一律留在 src/ocv.ts，这里不重复实现，避免两边漂移。
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "src", "ocv.ts");

/** GUI 从 Finder 启动时 PATH 很干净，which 找不到 bun，所以先试常见安装位置 */
function findBun() {
  const cands = [process.env.BUN_BIN, path.join(os.homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  const r = spawnSync("which", ["bun"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : "bun";
}

const BUN = findBun();
let win = null;
let child = null;
let paths = null;

function readConfig() {
  const r = spawnSync(BUN, ["run", CLI, "config"], { encoding: "utf8", cwd: ROOT });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "ocv config 执行失败").trim());
  const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  paths = parsed._paths ?? null;
  return parsed;
}

function ensurePaths() {
  if (!paths) readConfig();
  return paths;
}

/** 界面回传的配置带 _paths（只读路径信息），落盘前剔除 */
function saveConfig(cfg) {
  const clean = Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith("_")));
  fs.writeFileSync(ensurePaths().config, JSON.stringify(clean, null, 2) + "\n");
  return { ok: true, at: ensurePaths().config };
}

function readState() {
  const file = ensurePaths().state;
  if (!fs.existsSync(file)) return { branches: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function startRun(args) {
  if (child) return { ok: false, error: "已有任务在跑" };
  const argv = [CLI, "run", ...args];
  child = spawn(BUN, argv, { cwd: ROOT });
  win?.webContents.send("ocv:out", `$ bun ${path.relative(ROOT, CLI)} ${["run", ...args].join(" ")}\n\n`);
  child.stdout.on("data", (d) => win?.webContents.send("ocv:out", d.toString()));
  child.stderr.on("data", (d) => win?.webContents.send("ocv:out", d.toString()));
  child.on("close", (code) => {
    child = null;
    win?.webContents.send("ocv:out", `\n[退出码 ${code}]\n`);
    win?.webContents.send("ocv:done", code);
  });
  return { ok: true };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    title: "ocv 控制台",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.once("did-finish-load", () => {
    console.log(`ocv-app ready (bun=${BUN}, root=${ROOT})`);
    // 自动化验收用：可点击某个控件、滚到底再截图，然后自退；不影响正常启动
    if (!process.env.OCV_APP_SHOT) return;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    setTimeout(async () => {
      if (process.env.OCV_APP_EVAL) {
        await win.webContents.executeJavaScript(process.env.OCV_APP_EVAL);
        await sleep(Number(process.env.OCV_APP_EVAL_WAIT ?? 5000));
      }
      if (process.env.OCV_APP_SCROLL) await win.webContents.executeJavaScript("window.scrollTo(0, document.body.scrollHeight)");
      await sleep(400);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.OCV_APP_SHOT, img.toPNG());
      console.log(`ocv-app shot -> ${process.env.OCV_APP_SHOT}`);
      app.quit();
    }, Number(process.env.OCV_APP_SHOT_DELAY ?? 2000));
  });
}

ipcMain.handle("ocv:config", () => readConfig());
ipcMain.handle("ocv:save", (_e, cfg) => saveConfig(cfg));
ipcMain.handle("ocv:state", () => readState());
ipcMain.handle("ocv:run", (_e, args) => startRun(args));
ipcMain.handle("ocv:cancel", () => {
  if (!child) return { ok: false, error: "没有在跑的任务" };
  child.kill("SIGTERM");
  return { ok: true };
});
ipcMain.handle("ocv:open", (_e, what) => {
  if (typeof what === "string" && /^https?:\/\//.test(what)) return shell.openExternal(what);
  const p = ensurePaths();
  const target = what === "reports" ? p.reports : what === "config" ? p.config : p.root;
  return shell.openPath(target);
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => child?.kill("SIGTERM"));