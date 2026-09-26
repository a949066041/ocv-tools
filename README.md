# ocv

夜间批量审查 feature 分支:扫仓库 → 无头 agent(omp)审 diff → 自动修 critical/high → 推修复分支并提 PR(gitee/github/手动链接),本地与仓库内各留一份 Markdown 报告。附带 Electron 控制台。

## 依赖

- [Bun](https://bun.sh)(运行时 + 测试)
- git ≥ 2.41(太旧会让 `ocr delegate preview` 报 cannot find merge-base;ocv 会自动挑本机最新的 git)
- [open-code-review](https://github.com) 的 `ocr` 命令在 PATH 里(`run` 前会 preflight,缺了直接报错)
- 无头 agent 二进制(默认 `omp`,可用 `agent.bin` 改)

```bash
bun install
```

## 配置

`~/.ocv/ocv.config.json`(GUI 或 `ocv save-config` 写入,均过 zod 校验;`OCV_ROOT` 可改数据根,打包版指向 userData):

- `branches`:逗号分隔 glob,匹配要审的远端分支;`repos[].branches` 可覆盖
- `baseCandidates`:基线分支候选,按序取第一个存在的;`repos[].base` 可覆盖
- `maxAgeDays`/`maxBranches`/`maxFiles`:跳过久未提交/超额分支/超额改动,防一夜烧穿
- `concurrency`:并发 agent 数
- `reportInRepo`:审查报告提交进分支的子目录,留空关闭
- `agent.bin`/`agent.model`/`agent.timeoutMinutes`/`agent.extraArgs`
- `pr.giteeTokenEnv`/`pr.githubTokenEnv`:**环境变量名**,不是 token 本体(填了 token 会直接报错)
- `commit.name`/`commit.email`:修复/报告提交的机器人署名(默认 `ocv-bot`),只注入子进程环境变量,不碰仓库与全局 `user.name`
- `notify.webhook`:机器人 webhook URL;每跑完一个仓库 POST 一条 JSON 摘要(`msgtype`+`text.content` 兼容企业微信/钉钉机器人,另带 `repo/branches/fixed/counts/prs/errors` 结构化字段),空串关闭;通知失败只打日志不阻塞其余仓库

token 放环境变量,或 `~/.ocv/.ocv.secrets.json`(权限 600,不进仓库):

```json
{ "GITEE_TOKEN": "***" }
```

## 命令

```bash
bun run ocv add <path> [--name x] [--base origin/master] [--branches "feat/*"] [--pr gitee|github|manual]
bun run ocv remove <name>
bun run ocv status
bun run ocv config          # 有效配置 + 各路径(JSON)
bun run ocv run [--repo <glob>] [--branch <glob>] [--force] [--dry-run] [--keep] [--concurrency N]
```

- `--dry-run` 只扫不跑;`--force` 忽略「同 sha 已审过」;`--keep` 保留 worktree 现场
- 同 sha 的分支下次自动跳过;报告在 `reports/<日期>/INDEX.md`
- 所有失败路径降级为手动 PR 链接,不阻塞其余分支

## GUI

```bash
bun run app
```

改配置点「保存配置」(走 CLI 校验,写坏立刻报错);「试跑」= `--dry-run`;日志实时转发。右上角实时检测 open-code-review:未装给「安装 OCR」、落后给「更新 OCR」(一键 `npm i -g`,输出进日志面板);ocv 自身落后 GitHub Release 时给「查看更新」。

- 界面:左上角 logo;「全局设置」收进右侧抽屉;仓库表整行铺开,分支匹配支持「多选远端分支」与「手动写 glob/正则」两种模式(多选存成逗号 glob,CLI 语义不变)
- 托盘:菜单栏常驻月亮图标,菜单含「显示窗口 / 防休眠 / 退出」;关窗只收进托盘,任务继续跑,真退出走托盘或 Cmd+Q
- 防休眠:运行面板「防休眠」按钮(powerSaveBlocker),点「立即运行/试跑」自动开启,防止夜间合盖/息屏冻住 agent 子进程

## 打包与发布

```bash
bun run dist              # 只打包:dist/ocv-<版本>-arm64-mac.zip(未签名,macOS zip)
GH_TOKEN=xxx bun run release   # 打包 + 推 GitHub Release(zip + latest-mac.yml),客户端右上角随即提示更新
```

`release` 的 token 也可放 `~/.ocv/.ocv.secrets.json` 的 `GITHUB_TOKEN`。打包版配置/状态/报告在 `~/Library/Application Support/ocv-agent/`(OCV_ROOT 指向它),不写进 app 包(包内只读)。

## 测试

```bash
bun test          # 63 个用例:单元 + git 夹具集成 + 全闭环 e2e(假 ocr/假 agent,离线)
bun run typecheck # src + renderer 双工程
bun run check     # 两者串联
```

e2e 用临时 git 仓库 + PATH 上的假 `ocr`/假 agent 跑真实 CLI 子进程(`OCV_ROOT` 隔离),覆盖扫描、worktree、修复提交、推送、仓库内报告、INDEX、状态去重、maxFiles/无可审文件预筛、save-config 校验。PR API 路径用本地 mock server 覆盖(成功/401/异常/secrets 兜底)。
