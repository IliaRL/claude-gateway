#!/usr/bin/env bash
# claude-mode.sh — toggle Claude Code between native Anthropic auth and the AIClient2API proxy.
#
# Usage:
#   claude-mode.sh on        # switch to proxy (AIClient2API)
#   claude-mode.sh off       # switch to native Anthropic
#   claude-mode.sh status    # show current mode
#
# When sourced (not executed), this file also exports `claude-proxy` / `claude-native` /
# `claude-mode-status` as shell functions that update the *parent* shell's env vars in addition
# to the persistent settings.json. That's the only way Claude Code picks up the change without
# a full restart.

# Detect sourced vs executed across bash AND zsh. We deliberately do NOT use `set -u` /
# `set -o pipefail` here — those would leak into the parent shell when sourced and break
# unrelated hooks (Amazon Q's `Q_DOTFILES_SOURCED`, fig's `precmd_functions`, etc.).
_claude_mode_sourced=0
if [ -n "${ZSH_VERSION:-}" ]; then
  # zsh: ZSH_EVAL_CONTEXT ends with ":file" when sourced from a file
  case "${ZSH_EVAL_CONTEXT:-}" in
    *:file*) _claude_mode_sourced=1 ;;
  esac
elif [ -n "${BASH_VERSION:-}" ]; then
  # bash: BASH_SOURCE[0] differs from $0 when sourced
  [ "${BASH_SOURCE[0]}" != "${0}" ] && _claude_mode_sourced=1
fi

CLAUDE_SETTINGS_FILE="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"
CLAUDE_PROXY_BACKUP_FILE="${CLAUDE_PROXY_BACKUP_FILE:-$HOME/.claude/proxy_settings_backup.json}"
ANTIGRAVITY_SETTINGS_FILE="${ANTIGRAVITY_SETTINGS_FILE:-$HOME/Library/Application Support/Antigravity IDE/User/settings.json}"

# Single source of truth for the proxy address/token.
# PROXY_BASE points to Tier1 AIClient2API (:3000) — Claude Code talks to it directly.
# 2-tier architecture: there is no LiteLLM middle tier. This is the authoritative
# request + model-discovery path. See MASTER-C/CLAUDE.md.
: "${PROXY_BASE:=http://127.0.0.1:3000}"
: "${PROXY_TOKEN:=${AICLIENT_TOKEN:-sk-a60f3efdf9b97e63c84ab4a3583f9d1c}}"
: "${AICLIENT_BASE:=${AICLIENT_BASE:-http://127.0.0.1:3000}}"
: "${AICLIENT_TOKEN:=}"

# Model to use in proxy mode — a provider-qualified id from the Tier1 (:3000) catalog.
: "${PROXY_CLI_MODEL:=claude-kiro-oauth:claude-sonnet-4-6}"
# Fallback model for native mode (Anthropic alias).
: "${NATIVE_CLI_MODEL:=sonnet}"

_claude_mode_require_jq() {
  if ! command -v jq &>/dev/null; then
    echo "ERROR: 'jq' is required. Install with: brew install jq" >&2
    return 1
  fi
}

_claude_mode_proxy_alive() {
  [ -n "$PROXY_TOKEN" ] || return 1
  curl -sf -o /dev/null --max-time 2 \
    "$PROXY_BASE/health" 2>/dev/null
}

# Persist (or remove) the proxy env block inside Claude Code's settings.json.
# Also switches the CLI model so requests route directly without alias fallback.
_claude_mode_write_settings() {
  local mode="$1" base="$2" token="$3"
  _claude_mode_require_jq || return 1
  [ -f "$CLAUDE_SETTINGS_FILE" ] || printf '{}' >"$CLAUDE_SETTINGS_FILE"

  local tmp="${CLAUDE_SETTINGS_FILE}.tmp.$$"
  if [ "$mode" = "on" ]; then
    # Save the current native model before switching so we can restore it later.
    local old_model
    old_model="$(jq -r '.model // "sonnet"' "$CLAUDE_SETTINGS_FILE" 2>/dev/null)"
    local backup_tmp="${CLAUDE_PROXY_BACKUP_FILE}.tmp.$$"
    if [ -f "$CLAUDE_PROXY_BACKUP_FILE" ]; then
      jq --arg m "$old_model" '. + {native_model: $m}' "$CLAUDE_PROXY_BACKUP_FILE" >"$backup_tmp" && mv "$backup_tmp" "$CLAUDE_PROXY_BACKUP_FILE"
    else
      printf '{"native_model": "%s"}' "$old_model" >"$CLAUDE_PROXY_BACKUP_FILE"
    fi
    # Set proxy env vars and switch model to a direct proxy catalog entry.
    # Only ANTHROPIC_API_KEY is set — ANTHROPIC_AUTH_TOKEN is for Anthropic OAuth/native auth
    # and must never be present alongside ANTHROPIC_API_KEY (causes Claude Code conflict + silent drops).
    jq --arg base "$base" --arg token "$token" --arg model "$PROXY_CLI_MODEL" \
      '.env = (.env // {}) | .env.ANTHROPIC_BASE_URL = $base | .env.ANTHROPIC_API_KEY = $token | .env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1" | .env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0" | .env.ENABLE_TOOL_SEARCH = "true" | del(.env.ANTHROPIC_AUTH_TOKEN) | .model = $model' \
      "$CLAUDE_SETTINGS_FILE" >"$tmp" && mv "$tmp" "$CLAUDE_SETTINGS_FILE"
    # Clear the claude.ai OAuth token from config.json so ANTHROPIC_API_KEY is the
    # sole auth method and Claude Code doesn't show the "both a token and an API key
    # are set" conflict warning.
    local claude_config="$HOME/Library/Application Support/Claude/config.json"
    if [ -f "$claude_config" ] && command -v jq &>/dev/null; then
      local cc_tmp="${claude_config}.tmp.$$"
      jq 'del(.["oauth:tokenCache"])' "$claude_config" >"$cc_tmp" && mv "$cc_tmp" "$claude_config"
    fi
    # Also sync Antigravity IDE settings: model + proxy env vars in terminal.integrated.env.osx
    if [ -f "$ANTIGRAVITY_SETTINGS_FILE" ]; then
      local ag_tmp="${ANTIGRAVITY_SETTINGS_FILE}.tmp.$$"
      jq --arg model "$PROXY_CLI_MODEL" \
         --arg base "$base" --arg token "$token" \
        '.["claude.model"] = $model
         | .["terminal.integrated.env.osx"] = (
             (.["terminal.integrated.env.osx"] // {})
             + {ANTHROPIC_BASE_URL: $base, ANTHROPIC_API_KEY: $token,
                AICLIENT_BASE: $base, AICLIENT_TOKEN: $token,
                CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
                ENABLE_TOOL_SEARCH: "true"}
             | del(.ANTHROPIC_AUTH_TOKEN)
           )' \
        "$ANTIGRAVITY_SETTINGS_FILE" >"$ag_tmp" && mv "$ag_tmp" "$ANTIGRAVITY_SETTINGS_FILE"
    fi
  else
    # Restore native model from backup (default to NATIVE_CLI_MODEL if backup missing).
    local native_model
    native_model="$(jq -r '.native_model // empty' "$CLAUDE_PROXY_BACKUP_FILE" 2>/dev/null)"
    [ -z "$native_model" ] && native_model="$NATIVE_CLI_MODEL"
    jq --arg m "$native_model" \
      'if has("env") then .env |= (del(.ANTHROPIC_BASE_URL, .ANTHROPIC_AUTH_TOKEN, .ANTHROPIC_API_KEY, .CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, .CLAUDE_CODE_ATTRIBUTION_HEADER, .ENABLE_TOOL_SEARCH)) else . end | .model = $m' \
      "$CLAUDE_SETTINGS_FILE" >"$tmp" && mv "$tmp" "$CLAUDE_SETTINGS_FILE"
    # Also sync Antigravity IDE settings: restore native model, strip proxy env vars
    if [ -f "$ANTIGRAVITY_SETTINGS_FILE" ]; then
      local ag_tmp="${ANTIGRAVITY_SETTINGS_FILE}.tmp.$$"
      jq --arg model "$native_model" \
        '.["claude.model"] = $model
         | .["terminal.integrated.env.osx"] = (
             (.["terminal.integrated.env.osx"] // {})
             | del(.ANTHROPIC_BASE_URL, .ANTHROPIC_AUTH_TOKEN, .ANTHROPIC_API_KEY, .AICLIENT_BASE, .AICLIENT_TOKEN, .CLAUDE_CODE_ATTRIBUTION_HEADER, .ENABLE_TOOL_SEARCH)
           )' \
        "$ANTIGRAVITY_SETTINGS_FILE" >"$ag_tmp" && mv "$ag_tmp" "$ANTIGRAVITY_SETTINGS_FILE"
    fi
  fi
}

claude-proxy() {
  _claude_mode_require_jq || return 1

  if [ -z "$PROXY_TOKEN" ]; then
    echo "ERROR: AICLIENT_TOKEN is empty. Source ~/.zshrc before toggling." >&2
    return 1
  fi

  local base="$PROXY_BASE" token="$PROXY_TOKEN"

  _claude_mode_write_settings on "$base" "$token" || return 1
  export ANTHROPIC_BASE_URL="$base"
  export ANTHROPIC_API_KEY="$token"
  unset ANTHROPIC_AUTH_TOKEN
  export CLAUDE_CODE_ATTRIBUTION_HEADER=0
  export ENABLE_TOOL_SEARCH=true

  if ! _claude_mode_proxy_alive; then
    echo "WARN: AIClient2API (Tier1) at $base did not respond. Run 'start-proxies' first." >&2
  fi
  echo "proxy" > /tmp/aiclient_mode
  echo "✅ Claude Code → PROXY mode ($base)"
}

claude-native() {
  _claude_mode_require_jq || return 1

  # NOTE: intentionally does NOT stop the proxy process. Killing :3000 while
  # a Claude session is mid-execution disconnects it. Use stop-proxies explicitly
  # when you want to shut the gateway down.

  # Back up current proxy settings (if any) before removing them.
  if [ -f "$CLAUDE_SETTINGS_FILE" ]; then
    local has_proxy
    has_proxy="$(jq -r '(.env // {}) | (has("ANTHROPIC_BASE_URL") or has("ANTHROPIC_AUTH_TOKEN"))' "$CLAUDE_SETTINGS_FILE" 2>/dev/null || echo false)"
    if [ "$has_proxy" = "true" ]; then
      # Only back up non-empty values — an empty ANTHROPIC_AUTH_TOKEN causes an auth
      # conflict warning when restored alongside ANTHROPIC_API_KEY on next proxy switch.
      jq '.env // {} | {ANTHROPIC_BASE_URL: (.ANTHROPIC_BASE_URL // "")} | with_entries(select(.value != ""))' \
        "$CLAUDE_SETTINGS_FILE" >"$CLAUDE_PROXY_BACKUP_FILE"
    fi
  fi

  _claude_mode_write_settings off "" "" || return 1
  unset ANTHROPIC_BASE_URL
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_AUTH_TOKEN
  unset CLAUDE_CODE_ATTRIBUTION_HEADER
  unset ENABLE_TOOL_SEARCH
  rm -f /tmp/aiclient_last_model
  echo "native" > /tmp/aiclient_mode

  echo "✅ Claude Code → NATIVE mode (Anthropic direct)"
}

claude-mode-status() {
  local settings_mode="unknown"
  local env_mode="unknown"

  if [ -f "$CLAUDE_SETTINGS_FILE" ] && command -v jq &>/dev/null; then
    local in_settings
    in_settings="$(jq -r '(.env // {}) | (has("ANTHROPIC_BASE_URL") or has("ANTHROPIC_AUTH_TOKEN"))' "$CLAUDE_SETTINGS_FILE" 2>/dev/null || echo false)"
    [ "$in_settings" = "true" ] && settings_mode="proxy" || settings_mode="native"
  fi

  if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    env_mode="proxy ($ANTHROPIC_BASE_URL)"
  else
    env_mode="native"
  fi

  echo "── Claude Code mode ──────────────────────"
  echo "  settings.json:     $settings_mode"
  echo "  current shell env: $env_mode"
  if _claude_mode_proxy_alive; then
    echo "  AIClient2API :3000: reachable ($PROXY_BASE)"
  else
    echo "  AIClient2API :3000: not reachable — run start-proxies"
  fi
  echo "──────────────────────────────────────────"
}

# When executed (not sourced) dispatch the subcommand. When sourced this block is skipped
# and the functions above are available in the parent shell — DO NOT run status here, or
# the block prints on every shell open.
if [ "$_claude_mode_sourced" -eq 0 ]; then
  # Enable strict mode only in the executed path so it can't leak into the parent shell.
  set -uo pipefail
  case "${1:-status}" in
    on|proxy)   claude-proxy ;;
    off|native) claude-native ;;
    status)     claude-mode-status ;;
    *)
      echo "Usage: $0 {on|off|status}" >&2
      exit 1
      ;;
  esac
fi
unset _claude_mode_sourced
