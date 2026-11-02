#!/usr/bin/env bash
# X 智能客服 Demo — 启动脚本
# 用法: bash start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE=".data/server.pid"
LOG_FILE=".data/server.log"

# ── 预检 ──────────────────────────────────────────────
# 1. Node.js
#    兼容 nvm 环境：bash start.sh / zsh start.sh 这类非交互式 shell 不会加载
#    ~/.zshrc（nvm 的初始化脚本只对交互式 shell 生效），PATH 里可能没有 node，
#    所以这里自动从 nvm 中定位并加载 node。
if ! command -v node &>/dev/null; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  NVM_NODE_BIN=""
  # 优先使用 nvm 默认版本
  if [ -f "$NVM_DIR/alias/default" ]; then
    NVM_VER=$(tr -d 'v' < "$NVM_DIR/alias/default")
    if [ -x "$NVM_DIR/versions/node/v$NVM_VER/bin/node" ]; then
      NVM_NODE_BIN="$NVM_DIR/versions/node/v$NVM_VER/bin"
    fi
  fi
  # 兜底：任意一个已安装的 nvm 版本
  if [ -z "$NVM_NODE_BIN" ] && [ -d "$NVM_DIR/versions/node" ]; then
    for NVM_VER_DIR in "$NVM_DIR"/versions/node/v*; do
      if [ -x "$NVM_VER_DIR/bin/node" ]; then
        NVM_NODE_BIN="$NVM_VER_DIR/bin"
        break
      fi
    done
  fi
  if [ -n "$NVM_NODE_BIN" ]; then
    export PATH="$NVM_NODE_BIN:$PATH"
  fi
fi
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 Node.js，请先安装 Node.js >= 18"
  exit 1
fi

NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js 版本过低（当前 v$NODE_VER），需要 >= 18"
  exit 1
fi

# 2. .env
if [ ! -f .env ]; then
  echo "❌ 未找到 .env 文件，请先配置环境变量（参考 README.md）"
  exit 1
fi

# 3. node_modules
if [ ! -d node_modules ]; then
  echo "📦 首次运行，安装依赖..."
  npm install --no-audit --no-fund
  echo ""
fi

# 4. .data 目录
mkdir -p .data

# 5. check if already running
if [ -f "$PID_FILE" ]; then
  _pid=$(tr -cd '0-9' < "$PID_FILE" 2>/dev/null || true)
  if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
    echo "Service already running (PID $_pid)"
    echo "  To restart: bash stop.sh"
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

# ── 启动 ──────────────────────────────────────────────
# 兼容 macOS BSD grep（不支持 -P），用 sed 提取 PORT
PORT=$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' .env 2>/dev/null || echo "")
PORT=${PORT:-3000}

# 记录旧日志偏移，便于只展示本次启动的日志
OLD_LOG_SIZE=0
[ -f "$LOG_FILE" ] && OLD_LOG_SIZE=$(wc -c < "$LOG_FILE" | tr -d ' ')

nohup node server.js >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

# 等待端口就绪（最多 10 秒），同时检查进程存活
for i in $(seq 1 20); do
  # 进程已退出 → 启动失败
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "❌ 服务启动失败（进程已退出），查看日志:"
    tail -n 20 "$LOG_FILE" 2>/dev/null
    rm -f "$PID_FILE"
    exit 1
  fi
  if curl -s -o /dev/null "http://localhost:$PORT" 2>/dev/null; then
    echo "🚀 X 智能客服 Demo 已启动"
    echo "   PID:  $NEW_PID"
    echo "   地址: http://localhost:$PORT"
    echo "   日志: $LOG_FILE"
    echo ""
    echo "   停止: bash stop.sh"
    exit 0
  fi
  sleep 0.5
done

# 端口未就绪但进程仍在，可能是启动慢
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Service started (PID $NEW_PID), but port $PORT not ready yet"
  echo "  Visit later: http://localhost:$PORT"
  echo "  View logs: tail -f $LOG_FILE"
else
  echo "❌ 服务启动失败，查看日志:"
  tail -n 20 "$LOG_FILE" 2>/dev/null
  rm -f "$PID_FILE"
  exit 1
fi
