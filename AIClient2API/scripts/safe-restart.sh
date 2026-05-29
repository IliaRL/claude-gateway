#!/bin/bash
# scripts/safe-restart.sh
# Atomic restart for AIClient2API (Tier 1, port 3000).
# 2-tier architecture: Claude Code talks DIRECTLY to this proxy on :3000.
# (Tier 2 / LiteLLM was removed — it corrupted the Anthropic SSE stream and added latency.)

PORT=3000
MASTER_PORT=3100
LOG_FILE="/tmp/aiclient.log"

kill_listening_port() {
    local target_port=$1
    local name=$2
    echo "Stopping existing $name on port $target_port..."
    # Find the actual listening process, not the established connections.
    # Using -iTCP:$PORT -sTCP:LISTEN avoids killing the parent Claude process.
    local PID=$(lsof -nP -iTCP:$target_port -sTCP:LISTEN -t 2>/dev/null)
    if [ ! -z "$PID" ]; then
        echo "Found listening PID for $name: $PID. Killing..."
        kill $PID 2>/dev/null
        for i in $(seq 1 16); do
            if [ -z "$(lsof -nP -iTCP:$target_port -sTCP:LISTEN -t 2>/dev/null)" ]; then
                break
            fi
            sleep 0.5
        done
        local REMAIN=$(lsof -nP -iTCP:$target_port -sTCP:LISTEN -t 2>/dev/null)
        if [ ! -z "$REMAIN" ]; then
            echo "Process $REMAIN still listening on $target_port, sending SIGKILL..."
            kill -9 $REMAIN 2>/dev/null
            sleep 1
        fi
    fi
}

kill_listening_port $PORT "AIClient2API Proxy"
kill_listening_port $MASTER_PORT "AIClient2API Master"

if [ ! -z "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)" ]; then
    echo "Error: Port $PORT is still being listened on after kill."
    exit 1
fi

# Memory headroom guard — starting the proxy when RAM is near-full pushes total
# resident memory past the jetsam threshold on this 16GB machine, which thrashes
# swap and triggers a WindowServer userspace-watchdog KERNEL PANIC.
# (Verified 2026-05-29: jetsam at 15.1GB/16GB resident; node MCP fleet 4.9GB was the
#  largest consumer, with Antigravity IDE + Comet ~2GB each.) See Troubleshooting Issue 10.
MIN_FREE_MB=${MIN_FREE_MB:-4096}
AVAIL_MB=$(vm_stat 2>/dev/null | awk -v ps=$(sysctl -n hw.pagesize) '
  /^Pages free/        {gsub(/\./,"",$NF); f=$NF}
  /^Pages inactive/    {gsub(/\./,"",$NF); i=$NF}
  /^Pages speculative/ {gsub(/\./,"",$NF); s=$NF}
  /^Pages purgeable/   {gsub(/\./,"",$NF); p=$NF}
  END { print int((f+i+s+p)*ps/1048576) }')
if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt "$MIN_FREE_MB" ]; then
    echo "ABORT: only ${AVAIL_MB}MB reclaimable RAM (< ${MIN_FREE_MB}MB floor)."
    echo "Starting the proxy now risks a memory-pressure (jetsam) kernel panic."
    echo "Free RAM first (e.g. quit Antigravity IDE / Comet). Top consumers:"
    ps -Ao rss,comm -m 2>/dev/null | head -9 | awk 'NR>1{printf "  %6.0f MB  %s\n",$1/1024,$2}'
    echo "(Override with MIN_FREE_MB=0 ./scripts/safe-restart.sh if you are sure.)"
    exit 1
fi
echo "Memory headroom: ${AVAIL_MB}MB reclaimable — OK to start."

# Rotate log if it exceeds 10MB to prevent I/O contention
if [ -f "$LOG_FILE" ]; then
    LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$LOG_SIZE" -gt 10485760 ]; then
        echo "Rotating large log file $LOG_FILE..."
        mv "$LOG_FILE" "${LOG_FILE}.old"
    fi
fi

echo "Starting AIClient2API (Tier 1)..."
cd /Users/ilialiston/MASTER-C/AIClient2API && nohup pnpm start > $LOG_FILE 2>&1 &

echo "Waiting for Tier 1 to be ready..."
PROXY_READY=0
for i in $(seq 1 40); do
    if curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" \
        http://127.0.0.1:$PORT/v1/models -o /dev/null 2>/dev/null; then
        echo "AIClient2API is ready!"
        PROXY_READY=1
        break
    fi
    sleep 0.5
done

if [ $PROXY_READY -eq 0 ]; then
    echo "Error: AIClient2API did not start within 20 seconds."
    tail -n 15 $LOG_FILE
    exit 1
fi

echo "AIClient2API (Tier 1) restarted and ready."
exit 0
