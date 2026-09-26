#!/usr/bin/env bash
# 打包并发布:产物(zip + latest-mac.yml)推到 GitHub Releases,客户端下次启动即可看到更新。
# 用法: ./scripts/release.sh [bump]   # bump = 先把 patch 版本号 +1 再发
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(jq -r '.GITHUB_TOKEN // empty' "$HOME/.ocv/.ocv.secrets.json" 2>/dev/null || true)
fi
[ -n "$TOKEN" ] || { echo "缺少 GITHUB_TOKEN:放环境变量或 ~/.ocv/.ocv.secrets.json"; exit 1; }

if [ "${1:-}" = "bump" ]; then
  npm version patch --no-git-tag-version >/dev/null
fi
VERSION=$(jq -r .version package.json)

echo "==> 构建渲染层 + 打包 v${VERSION} + 推送 GitHub Release"
bun run build:renderer
GH_TOKEN="$TOKEN" bunx electron-builder --mac --publish always

echo "==> 完成: https://github.com/a949066041/ocv-tools/releases/tag/v${VERSION}"
