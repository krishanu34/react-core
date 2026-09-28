#!/usr/bin/env bash
# =============================================================================
# DevSphere AI — Stop Script
# =============================================================================

set -euo pipefail

DEVSPHERE_PORT=8003

echo ""
echo "====================================="
echo " DevSphere AI - Stopping service"
echo "====================================="

# Stop PM2 process (production / startup.sh deployments)
if command -v pm2 &>/dev/null; then
    pm2 delete devaccel-devsphere-ai 2>/dev/null || true
    echo "   PM2 process 'devaccel-devsphere-ai' stopped."
fi

# Kill any process still bound to port 8003 (dev / direct uvicorn runs)
PIDS=$(lsof -ti tcp:${DEVSPHERE_PORT} 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    echo "   Killing PID(s) on port ${DEVSPHERE_PORT}: $PIDS"
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
else
    echo "   Nothing running on port ${DEVSPHERE_PORT}."
fi

echo ""
echo "====================================="
echo " Done."
echo "====================================="
