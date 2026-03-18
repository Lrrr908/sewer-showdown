#!/bin/bash
# Watchdog: auto-restarts the server if it crashes
echo "[watchdog] Starting server watchdog..."
while true; do
    echo "[watchdog] Starting server..."
    cd /home/beast/sewer-showdown/server && node src/index.js
    echo "[watchdog] Server exited. Restarting in 3 seconds..."
    sleep 3
done
