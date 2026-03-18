#!/bin/bash
export PATH="/home/beast/.nvm/versions/node/v24.13.0/bin:$PATH"
echo "[watchdog] Starting server watchdog..."
while true; do
    echo "[watchdog] Starting server..."
    cd /home/beast/sewer-showdown/server && node src/index.js
    echo "[watchdog] Server exited. Restarting in 3 seconds..."
    sleep 3
done
