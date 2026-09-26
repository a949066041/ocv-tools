// Electron 主进程：只做三件事——读写配置、跑 ocv CLI 并转发输出、把状态读给界面。
// 业务规则一律留在 src/，这里不重复实现，避免两边漂移。
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage, powerSaveBlocker } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// 打包后 Resources/app 只读:配置/状态/报告一律放 userData(paths.ts 认 OCV_ROOT)
if (app.isPackaged) process.env.OCV_ROOT = app.getPath("userData");
const CLI = path.join(ROOT, "src", "cli.ts");

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
let tray = null;
/** 防休眠 id;-1 表示未启用。夜间长跑合盖/息屏会冻住 agent 子进程,所以跑任务时默认开着 */
let keepAwakeId = -1;
/** Cmd+Q / 托盘退出时置真,close 钩子据此放行,否则关窗只收进托盘 */
let quitting = false;

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

/** 界面回传的配置带 _paths（只读路径信息），落盘前剔除；写盘走 CLI 的 zod 校验，写坏立刻报错而不是下次 run 才炸 */
function saveConfig(cfg) {
  const clean = Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith("_")));
  const r = spawnSync(BUN, ["run", CLI, "save-config"], { encoding: "utf8", cwd: ROOT, input: JSON.stringify(clean) });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "保存失败").trim() };
  return { ok: true, at: ensurePaths().config };
}

function readState() {
  const file = ensurePaths().state;
  if (!fs.existsSync(file)) return { branches: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // 状态是可重建的缓存(报告在 reports/ 里);坏了就空表起步,不让 GUI 白屏
    console.error(`状态文件损坏,按空状态起步: ${file} (${e.message})`);
    return { branches: {} };
  }
}

function startRun(args) {
  if (child) return { ok: false, error: "已有任务在跑" };
  setKeepAwake(true); // 夜间长跑防合盖/息屏冻住子进程;界面按钮可再关
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
/** 防休眠开关:跑任务期间默认开,界面/托盘都能切;退出时统一释放 */
function setKeepAwake(on) {
  if (on && keepAwakeId === -1) keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
  if (!on && keepAwakeId !== -1) { powerSaveBlocker.stop(keepAwakeId); keepAwakeId = -1; }
  buildTrayMenu();
  return keepAwakeId !== -1;
}

/** 托盘:月亮剪影模板图;菜单里放显示窗口/防休眠/退出 */
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 ocv 控制台", click: () => showWindow() },
    { label: keepAwakeId !== -1 ? "防休眠：开" : "防休眠：关", type: "checkbox", checked: keepAwakeId !== -1, click: (item) => setKeepAwake(item.checked) },
    { type: "separator" },
    { label: "退出", click: () => { win = null; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "tray@2x.png")));
  tray.setToolTip("ocv 控制台");
  tray.on("click", () => showWindow());
  buildTrayMenu();
}

function showWindow() {
  if (!win) return createWindow();
  win.show();
  win.focus();
}


function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    title: "ocv 控制台",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "dist", "index.html"));
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
  win.on("close", (e) => {
    if (quitting || win === null) return; // 真退出或托盘触发的关闭,放行
    e.preventDefault();
    win.hide();
  });
}

ipcMain.handle("ocv:pick-folder", async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: "选择 git 仓库目录",
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("ocv:check-env", () => {
  // 检查 bun 是否可用
  const bunCheck = spawnSync(BUN, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (bunCheck.status !== 0) return { ok: false, bun: BUN, error: `bun 不可用: ${bunCheck.stderr || bunCheck.error}` };
  // 检查 ocv CLI 是否可运行
  const cliCheck = spawnSync(BUN, ["run", CLI, "--help"], { encoding: "utf8", cwd: ROOT, timeout: 10000 });
  if (cliCheck.status !== 0) return { ok: false, bun: BUN, error: `ocv CLI 不可用: ${cliCheck.stderr || cliCheck.stdout}` };
  return { ok: true, bun: BUN, bunVersion: bunCheck.stdout.trim() };
});

ipcMain.handle("ocv:config", () => readConfig());
ipcMain.handle("ocv:save", (_e, cfg) => saveConfig(cfg));
ipcMain.handle("ocv:state", () => readState());
ipcMain.handle("ocv:run", (_e, args) => startRun(args));
ipcMain.handle("ocv:keep-awake", (_e, on) => (on === undefined ? keepAwakeId !== -1 : setKeepAwake(!!on)));
/** 分支多选面板的数据源:只列远端分支,失败(非 git 目录)返回空数组让界面回落手动输入 */
ipcMain.handle("ocv:branches", (_e, repoPath) => {
  const r = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"], { encoding: "utf8", cwd: repoPath, timeout: 10000 });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim().replace(/^origin\//, "")).filter((b) => b && b !== "HEAD");
});
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

/** ocr 环境:GUI 从 Finder 启动时 PATH 干净,统一走登录 shell 找 ocr/npm。
 *  全部异步,不阻塞主进程(npm view 可能几秒) */
const SH = "/bin/sh";
const OCR_PKG = "@alibaba-group/open-code-review";

function loginShellOut(cmd) {
  return new Promise((resolve) => {
    const proc = spawn(SH, ["-lc", cmd]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve({ code, out: out.trim() }));
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve({ code: -1, out }); }, 20000);
  });
}

ipcMain.handle("ocv:ocr-check", async () => {
  const [local, remote] = await Promise.all([
    loginShellOut("ocr --version 2>/dev/null | head -1"),
    loginShellOut(`npm view ${OCR_PKG} version 2>/dev/null`),
  ]);
  return {
    installed: local.code === 0 ? (local.out.match(/v?(\d+\.\d+\.\d+)/) ?? [])[1] ?? "" : null,
    latest: remote.code === 0 ? remote.out : "",
  };
});

/** ocv 自身更新:对比 GitHub Releases 最新版;打包版才查,开发版跳过 */
ipcMain.handle("ocv:update-check", async () => {
  if (!app.isPackaged) return { current: app.getVersion(), latest: "", url: "" };
  try {
    const res = await fetch("https://api.github.com/repos/a949066041/ocv-tools/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { current: app.getVersion(), latest: "", url: "" };
    const j = await res.json();
    return { current: app.getVersion(), latest: String(j.tag_name ?? "").replace(/^v/, ""), url: j.html_url ?? "" };
  } catch {
    return { current: app.getVersion(), latest: "", url: "" };
  }
});

/** 安装/更新共用一条命令;输出实时转发到日志面板 */
ipcMain.handle("ocv:ocr-install", () => {
  win?.webContents.send("ocv:out", `$ npm install -g ${OCR_PKG}@latest\n\n`);
  const proc = spawn(SH, ["-lc", `npm install -g ${OCR_PKG}@latest`]);
  proc.stdout.on("data", (d) => win?.webContents.send("ocv:out", d.toString()));
  proc.stderr.on("data", (d) => win?.webContents.send("ocv:out", d.toString()));
  return new Promise((resolve) => {
    proc.on("close", (code) => {
      resolve({ ok: code === 0, error: code === 0 ? undefined : `安装失败，退出码 ${code}` });
    });
  });
});

app.whenReady().then(() => {
  // 开发模式没有 .icns,Dock 会亮 Electron 默认图标;打包版图标由 build/icon.png 生成,无需补
  if (!app.isPackaged && process.platform === "darwin") app.dock.setIcon(path.join(__dirname, "..", "build", "icon.png"));
  createTray(); createWindow();
});
app.on("window-all-closed", () => { /* 托盘常驻,不随窗口关闭退出 */ });
app.on("before-quit", () => { quitting = true; child?.kill("SIGTERM"); if (keepAwakeId !== -1) powerSaveBlocker.stop(keepAwakeId); });