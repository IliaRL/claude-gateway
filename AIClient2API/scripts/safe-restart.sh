#!/bin/bash
# scripts/safe-restart.sh
# Atomic restart for AIClient2API (Tier 1, port 3000).
# 2-tier architecture: Claude Code talks DIRECTLY to this proxy on :3000.
# (Tier 2 / LiteLLM was removed — it corrupted the Anthropic SSE stream and added latency.)

PORT=3000
MASTER_PORT=3100
# [UPDATED]: Changed log file from /tmp/ (which is wiped on reboot) to a persistent location in the user's library.
LOG_FILE="$HOME/Library/Logs/aiclient.log"
# [NEW]: Added a dedicated execution trace log to track the script's progress persistently.
TRACE_LOG="$HOME/Library/Logs/safe-restart-trace.log"

# [NEW]: Robust logging function to capture exact state and force immediate disk writes.
log_step() {
    local step_msg="$1"
    local timestamp=$(date '+%Y-%m-%dT%H:%M:%S')
    # Capture available reclaimable RAM as system context to track memory drops during execution.
    local ram=$(vm_stat 2>/dev/null | awk -v ps=$(sysctl -n hw.pagesize) '/^Pages free/ {f=$3} /^Pages speculative/ {s=$3} /^Pages inactive/ {i=$3} /^Pages purgeable/ {p=$3} END {print int((f+s+i+p)*ps/1048576)}')
    
    local log_entry="[$timestamp] [RAM: ${ram}MB] $step_msg"
    echo "$log_entry" | tee -a "$TRACE_LOG"
    
    # [CRITICAL]: 'sync' forces the OS to immediately flush file system buffers to the physical disk.
    # This ensures that even if the system hard-freezes or panics a microsecond later, 
    # the log entry will survive the unclean shutdown.
    sync
}

log_step "START: Initiating safe-restart.sh"

kill_listening_port() {
    local target_port=$1
    local name=$2
    log_step "ACTION: Stopping existing $name on port $target_port..."
    # Find the actual listening process, not the established connections.
    # Using -iTCP:$PORT -sTCP:LISTEN avoids killing the parent Claude process.
    local PID=$(lsof -nP -iTCP:$target_port -sTCP:LISTEN -t 2>/dev/null)
    if [ ! -z "$PID" ]; then
        log_step "ACTION: Found listening PID for $name: $PID. Sending SIGTERM..."
        kill $PID 2>/dev/null
        for i in $(seq 1 16); do
            if ! kill -0 $PID 2>/dev/null; then
                break
            fi
            sleep 0.5
        done
        if kill -0 $PID 2>/dev/null; then
            log_step "ACTION: Process $PID still listening on $target_port, sending SIGKILL..."
            kill -9 $PID 2>/dev/null
            sleep 1
        fi
        log_step "SUCCESS: Killed $name on port $target_port."
    else
        log_step "INFO: No listening process found for $name on port $target_port."
    fi
}

log_step "PHASE: Killing old processes"
kill_listening_port $PORT "AIClient2API Proxy"
kill_listening_port $MASTER_PORT "AIClient2API Master"

# Kill any lingering semgrep-core-proprietary processes.
# CONFIRMED ROOT CAUSE: Two kernel panics on 2026-05-30 (23:18 and 23:50) were caused
# by 37–171 concurrent semgrep-core-proprietary processes consuming 57+ GB of virtual
# memory on a 16 GB machine, starving WindowServer until the kernel watchdog fired.
# Semgrep is spawned by Aikido scans and does NOT clean itself up between restarts.
SEMGREP_COUNT=$(pgrep -c semgrep-core-proprietary 2>/dev/null || echo 0)
if [ "$SEMGREP_COUNT" -gt 0 ]; then
    log_step "WARNING: Found $SEMGREP_COUNT semgrep-core-proprietary processes still alive. Killing all before starting proxy (these caused the kernel panics)."
    pkill -SIGKILL -f semgrep-core-proprietary 2>/dev/null
    sleep 1
    REMAINING=$(pgrep -c semgrep-core-proprietary 2>/dev/null || echo 0)
    if [ "$REMAINING" -gt 0 ]; then
        log_step "ERROR: $REMAINING semgrep processes survived SIGKILL. Memory pressure risk remains. Exiting."
        exit 1
    fi
    log_step "SUCCESS: All semgrep-core-proprietary processes killed."
else
    log_step "INFO: No semgrep-core-proprietary processes found — memory is safe to proceed."
fi

if [ ! -z "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)" ]; then
    log_step "ERROR: Port $PORT is still being listened on after kill. Exiting."
    exit 1
fi

log_step "PHASE: Memory Headroom Check"
# Memory headroom guard — starting the proxy when RAM is near-full pushes total
# resident memory past the jetsam threshold on this 16GB machine, which thrashes
# swap and triggers a WindowServer userspace-watchdog KERNEL PANIC.
MIN_FREE_MB=${MIN_FREE_MB:-2048}
AVAIL_MB=$(vm_stat 2>/dev/null | awk -v ps=$(sysctl -n hw.pagesize) '
  /^Pages free/        {gsub(/\./,"",$NF); f=$NF}
  /^Pages speculative/ {gsub(/\./,"",$NF); s=$NF}
  /^Pages inactive/    {gsub(/\./,"",$NF); i=$NF}
  /^Pages purgeable/   {gsub(/\./,"",$NF); p=$NF}
  END { print int((f+s+i+p)*ps/1048576) }')

if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt "$MIN_FREE_MB" ]; then
    log_step "ABORT: only ${AVAIL_MB}MB reclaimable RAM (< ${MIN_FREE_MB}MB floor)."
    echo "Starting the proxy now risks a memory-pressure (jetsam) kernel panic."
    echo "Free RAM first (e.g. quit Antigravity IDE / Comet). Top consumers:"
    ps -Ao rss,comm -m 2>/dev/null | head -9 | awk 'NR>1{printf "  %6.0f MB  %s\n",$1/1024,$2}'
    echo "(Override with MIN_FREE_MB=0 ./scripts/safe-restart.sh if you are sure.)"
    exit 1
fi
log_step "INFO: Memory headroom: ${AVAIL_MB}MB reclaimable — OK to start."

# Rotate log if it exceeds 10MB to prevent I/O contention
if [ -f "$LOG_FILE" ]; then
    LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$LOG_SIZE" -gt 10485760 ]; then
        log_step "ACTION: Rotating large log file $LOG_FILE..."
        mv "$LOG_FILE" "${LOG_FILE}.old"
        sync
    fi
fi

log_step "PHASE: Starting AIClient2API"
cd /Users/ilialiston/MASTER-C/AIClient2API || { log_step "ERROR: Failed to cd to directory"; exit 1; }

log_step "ACTION: Executing pnpm start in background"
nohup pnpm start > "$LOG_FILE" 2>&1 &
PNPM_PID=$!
log_step "INFO: pnpm start spawned with PID $PNPM_PID"

log_step "PHASE: Waiting for Tier 1 to be ready"
PROXY_READY=0
for i in $(seq 1 40); do
    if curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" \
        http://127.0.0.1:$PORT/v1/models -o /dev/null 2>/dev/null; then
        log_step "SUCCESS: AIClient2API is ready!"
        PROXY_READY=1
        break
    fi
    sleep 0.5
    # Log progress occasionally to track if it freezes during wait
    if [ $((i % 10)) -eq 0 ]; then
        log_step "INFO: Still waiting for readiness (attempt $i/40)..."
    fi
done

if [ $PROXY_READY -eq 0 ]; then
    log_step "ERROR: AIClient2API did not start within 20 seconds."
    tail -n 15 "$LOG_FILE"
    exit 1
fi

log_step "FINISH: AIClient2API (Tier 1) restarted and ready."
exit 0
