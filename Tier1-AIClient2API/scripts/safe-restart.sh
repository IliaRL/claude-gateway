#!/bin/bash
# scripts/safe-restart.sh
# Atomic restart for AIClient2API (3000) and LiteLLM (4000)

PORT=3000
MASTER_PORT=3100
LITELLM_PORT=4000
LOG_FILE="/tmp/aiclient.log"
LITELLM_LOG="/tmp/litellm.log"

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
kill_listening_port $LITELLM_PORT "LiteLLM Gateway"

if [ ! -z "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)" ] || [ ! -z "$(lsof -nP -iTCP:$LITELLM_PORT -sTCP:LISTEN -t 2>/dev/null)" ]; then
    echo "Error: Ports are still being listened on after kill."
    exit 1
fi

# Rotate log if it exceeds 10MB to prevent I/O contention
for lf in "$LOG_FILE" "$LITELLM_LOG"; do
    if [ -f "$lf" ]; then
        LOG_SIZE=$(stat -f%z "$lf" 2>/dev/null || echo 0)
        if [ "$LOG_SIZE" -gt 10485760 ]; then
            echo "Rotating large log file $lf..."
            mv "$lf" "${lf}.old"
        fi
    fi
done

# Start Tier1 first — LiteLLM must NOT start until Tier1 is healthy.
# Starting both simultaneously causes a thundering herd: LiteLLM fires 80 concurrent
# health-check requests at :3000 before it has finished initializing, spiking CPU.
echo "Starting AIClient2API (Tier1)..."
cd /Users/ilialiston/AIClient2API && nohup pnpm start > $LOG_FILE 2>&1 &

echo "Waiting for Tier1 to be ready..."
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

# Only start LiteLLM once Tier1 is confirmed healthy.
echo "Starting LiteLLM Gateway (Tier2)..."
nohup /Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm \
  --config /Users/ilialiston/MASTER-C/Tier2-LiteLLM/litellm_config.yaml \
  --port $LITELLM_PORT > $LITELLM_LOG 2>&1 &

echo "Waiting for Tier2 to be ready..."
LITELLM_READY=0
for i in $(seq 1 40); do
    # nc check: LiteLLM enforces auth on /health and returns 401 — port open is enough
    if nc -z 127.0.0.1 $LITELLM_PORT 2>/dev/null; then
        echo "LiteLLM Gateway is ready!"
        LITELLM_READY=1
        break
    fi
    sleep 0.5
done

if [ $LITELLM_READY -eq 0 ]; then
    echo "Error: LiteLLM did not start within 20 seconds."
    tail -n 15 $LITELLM_LOG
    exit 1
fi

echo "Both services restarted and ready."
exit 0
