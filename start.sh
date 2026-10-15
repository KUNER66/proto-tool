#!/usr/bin/env bash
# ==========================================================================
# proto-tool · macOS / Linux 启动脚本
#   用法：  ./start.sh            （默认端口 7317）
#           PORT=7320 ./start.sh （自定义端口）
# ==========================================================================
set -e
cd "$(dirname "$0")"

APP_PORT="${PORT:-7317}"

echo
echo "  ============================================"
echo "     proto-tool  -  HTML annotation tool"
echo "  ============================================"
echo

# ---- 找 node ----
NODE_EXE=""
if command -v node >/dev/null 2>&1; then
  NODE_EXE="$(command -v node)"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_EXE="/usr/local/bin/node"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_EXE="/opt/homebrew/bin/node"
fi

if [ -z "$NODE_EXE" ]; then
  echo "  [X] Node.js not found."
  echo
  echo "  Please install Node.js 18 or newer:  https://nodejs.org"
  echo "  Or with Homebrew:  brew install node"
  echo
  exit 1
fi

NODE_MAJOR="$("$NODE_EXE" -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  [X] Node.js 18+ required, found $("$NODE_EXE" -v)"
  echo
  exit 1
fi

echo "  [1/2] Node runtime ready"
echo "        $NODE_EXE  ($("$NODE_EXE" -v))"
echo

# ---- 已在运行？ ----
if curl -s -m 2 "http://127.0.0.1:${APP_PORT}/api/ping" >/dev/null 2>&1; then
  echo "  [2/2] Already running, opening browser..."
  if command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:${APP_PORT}/"
  else
    xdg-open "http://127.0.0.1:${APP_PORT}/" >/dev/null 2>&1 || true
  fi
  exit 0
fi

echo "  [2/2] Starting service..."
echo
echo "  ------------------------------------------------"
echo "   URL:  http://127.0.0.1:${APP_PORT}/"
echo
echo "   Press Ctrl+C to stop."
echo "   Your notes are already saved into the HTML."
echo "  ------------------------------------------------"
echo

exec "$NODE_EXE" src/server.js --open --port "$APP_PORT"
