#!/bin/bash
export PATH="/home/beast/.nvm/versions/node/v24.13.0/bin:$PATH"

# Kill any existing instances first
pkill -f "watchdog.sh" 2>/dev/null
pkill -f "node src/index.js" 2>/dev/null
pkill -f "http.server 8080" 2>/dev/null
sleep 1

echo "=========================================="
echo "  SEWER SHOWDOWN — Starting Servers..."
echo "=========================================="
echo ""
echo "[*] Starting WebSocket server on :3000..."
bash /home/beast/sewer-showdown/server/watchdog.sh &

echo "[*] Starting HTTP server on :8080..."
cd /home/beast/sewer-showdown && python3 -m http.server 8080 &

echo ""
echo "  WebSocket : ws://localhost:3000"
echo "  Game      : http://localhost:8080"
echo ""
echo "  Both servers running. Close this window to stop."
echo "=========================================="
wait
