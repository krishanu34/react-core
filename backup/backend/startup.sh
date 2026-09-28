#!/usr/bin/env bash
# =============================================================================
# DevSphere AI — Startup Script
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$APP_DIR/.venv"

# ── Network config (override via environment, e.g. in CI / another machine) ──
#   DEVSPHERE_PORT        port to serve on
#   DEVSPHERE_BIND_HOST   interface gunicorn binds to (0.0.0.0 = all)
#   DEVSPHERE_PUBLIC_HOST hostname/IP shown in the startup banner and used
#                         by clients to reach the API (set to this machine's
#                         IP or DNS name when clients are on other machines)
DEVSPHERE_PORT="${DEVSPHERE_PORT:-8003}"
DEVSPHERE_BIND_HOST="${DEVSPHERE_BIND_HOST:-0.0.0.0}"
DEVSPHERE_PUBLIC_HOST="${DEVSPHERE_PUBLIC_HOST:-localhost}"

echo "========================================"
echo " DevSphere AI — Startup"
echo " App Dir : $APP_DIR"
echo "========================================"

# ── 1. Check Python ──────────────────────────────────────────────────────────
echo ""
echo ">> Step 1: Checking Python …"
PYTHON_BIN=$(command -v python3 || command -v python)
echo "   Python: $($PYTHON_BIN --version)"

# ── 2. Python virtual environment ───────────────────────────────────────────
echo ""
echo ">> Step 2: Setting up Python virtual environment …"

if [ ! -d "$VENV_DIR" ]; then
    echo "   Creating venv at $VENV_DIR …"
    $PYTHON_BIN -m venv "$VENV_DIR"
else
    echo "   Venv already exists at $VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

# ── 3. Install dependencies ──────────────────────────────────────────────────
echo ""
echo ">> Step 3: Installing Python requirements …"
pip install --upgrade pip --quiet
pip install -r "$APP_DIR/requirements.txt" --upgrade --quiet
echo "   Done."

# ── 4. PM2 check ─────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
    echo ""
    echo ">> PM2 not found — installing …"
    npm install -g pm2
fi

# ── 5. Stop existing process ─────────────────────────────────────────────────
echo ""
echo ">> Step 5: Stopping existing DevSphere AI process …"
pm2 delete devaccel-devsphere-ai 2>/dev/null || true

# Kill anything still on the port
PIDS=$(lsof -ti tcp:${DEVSPHERE_PORT} 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    echo "   Killing PID(s) on port ${DEVSPHERE_PORT}: $PIDS"
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
fi

# ── 6. Start DevSphere AI via PM2 ───────────────────────────────────────────
echo ""
echo ">> Step 6: Starting DevSphere AI on port ${DEVSPHERE_PORT} …"

pm2 start "$VENV_DIR/bin/gunicorn" \
    --name "devaccel-devsphere-ai" \
    --interpreter none \
    --cwd "$APP_DIR" \
    -- \
    devsphere_ai.router.apis:app \
    --workers 1 \
    --worker-class uvicorn.workers.UvicornWorker \
    --bind "${DEVSPHERE_BIND_HOST}:${DEVSPHERE_PORT}" \
    --timeout 600 \
    --chdir "$APP_DIR"

pm2 save

echo ""
echo "========================================"
echo " DevSphere AI running!"
echo "   API → http://${DEVSPHERE_PUBLIC_HOST}:${DEVSPHERE_PORT}"
echo "========================================"
echo ""
pm2 status
