#!/usr/bin/env bash
# validate-skills.sh — assert that every skill reference is still accurate
# Run after any system change. All assertions must pass before running aiclient-sync.
# To add a new assertion: append to the relevant section below.

SRC="/Users/ilialiston/AIClient2API/src"
PASS=0
FAIL=0

check() {
  local skill="$1" desc="$2" cmd="$3"
  if eval "$cmd" > /dev/null 2>&1; then
    echo "  ✅  [$skill] $desc"
    ((PASS++))
  else
    echo "  ❌  [$skill] $desc"
    echo "       CMD: $cmd"
    ((FAIL++))
  fi
}

echo ""
echo "=== AIClient2API Skill Reference Validation ==="
echo ""

# ── aiclient-health ──────────────────────────────────────────────────────────
echo "[ aiclient-health ]"
check "health" "_applyBadRequestCooldown in request-handlers.js" \
  "grep -q '_applyBadRequestCooldown' '$SRC/utils/request-handlers.js'"
check "health" "PROVIDER_MAPPINGS in provider-utils.js:14" \
  "grep -n 'PROVIDER_MAPPINGS' '$SRC/utils/provider-utils.js' | head -1 | grep -q '14:'"
check "health" "gemini-antigravity defaultCheckModel = gemini-3-flash" \
  "grep -A2 'gemini-antigravity' '$SRC/utils/provider-utils.js' | grep -q 'gemini-3-flash'"
check "health" "nvidia-nim defaultCheckModel = meta/llama-3.3-70b-instruct" \
  "grep -A2 'nvidia-nim' '$SRC/utils/provider-utils.js' | grep -q 'llama-3.3-70b'"

# ── aiclient-models ──────────────────────────────────────────────────────────
echo ""
echo "[ aiclient-models ]"
check "models" "PROVIDER_MODELS exported from provider-models.js" \
  "grep -q 'export.*PROVIDER_MODELS\|PROVIDER_MODELS.*=' '$SRC/providers/provider-models.js'"
check "models" "MODEL_CONTEXT_WINDOWS in converters/utils.js" \
  "grep -q 'MODEL_CONTEXT_WINDOWS' '$SRC/converters/utils.js'"
check "models" "MODEL_MAX_OUTPUT_TOKENS in converters/utils.js" \
  "grep -q 'MODEL_MAX_OUTPUT_TOKENS' '$SRC/converters/utils.js'"
check "models" "updateLastModelFile in request-handlers.js (not common.js)" \
  "grep -q 'updateLastModelFile' '$SRC/utils/request-handlers.js'"

# ── aiclient-routing ─────────────────────────────────────────────────────────
echo ""
echo "[ aiclient-routing ]"
check "routing" "_resolveEffectiveRouting in service-manager.js:377" \
  "grep -n '_resolveEffectiveRouting' '$SRC/services/service-manager.js' | head -1 | grep -q '377:'"
check "routing" "getApiServiceWithFallback in service-manager.js" \
  "grep -q 'getApiServiceWithFallback' '$SRC/services/service-manager.js'"
check "routing" "selectProvider in provider-pool-manager.js" \
  "grep -q 'selectProvider' '$SRC/providers/provider-pool-manager.js'"
check "routing" "normalizeConfiguredProviders in config-manager.js:12" \
  "grep -n 'normalizeConfiguredProviders' '$SRC/core/config-manager.js' | head -1 | grep -q '12:'"
check "routing" "handleAPIRequests in api-manager.js:32" \
  "grep -n 'handleAPIRequests' '$SRC/services/api-manager.js' | head -1 | grep -q '32:'"
check "routing" "fallback tracking: updateLastModelFile in request-handlers.js:602" \
  "grep -n 'updateLastModelFile' '$SRC/utils/request-handlers.js' | sed -n '2p' | grep -q '602:'"
check "routing" "handleModelListRequest in request-handlers.js (model aggregation)" \
  "grep -q 'handleModelListRequest' '$SRC/utils/request-handlers.js'"

# ── aiclient-statusline ───────────────────────────────────────────────────────
echo ""
echo "[ aiclient-statusline ]"
check "statusline" "updateLastModelFile renames to /tmp/aiclient_last_model at request-handlers.js:345" \
  "grep -n \"fs.rename.*aiclient_last_model'\" '$SRC/utils/request-handlers.js' | head -1 | grep -q '345:'"
check "statusline" "updateLastModelFile call in stream handler at request-handlers.js:602" \
  "grep -n 'updateLastModelFile' '$SRC/utils/request-handlers.js' | sed -n '2p' | grep -q '602:'"
check "statusline" "updateLastModelFile call in unary handler at request-handlers.js:951" \
  "grep -n 'updateLastModelFile' '$SRC/utils/request-handlers.js' | sed -n '3p' | grep -q '951:'"

# ── aiclient-debug ────────────────────────────────────────────────────────────
echo ""
echo "[ aiclient-debug ]"
check "debug" "handleModelListRequest in request-handlers.js (aggregation entry)" \
  "grep -q 'handleModelListRequest' '$SRC/utils/request-handlers.js'"
check "debug" "PROMPT_LOG_MODE key exists in config.json" \
  "grep -q 'PROMPT_LOG_MODE' '/Users/ilialiston/AIClient2API/configs/config.json'"

# ── aiclient-tooluse ──────────────────────────────────────────────────────────
echo ""
echo "[ aiclient-tooluse ]"
check "tooluse" "flattenToolArguments in converters/utils.js" \
  "grep -q 'flattenToolArguments' '$SRC/converters/utils.js'"
check "tooluse" "cleanJsonSchemaProperties in OpenAIConverter.js" \
  "grep -q 'cleanJsonSchema' '$SRC/converters/strategies/OpenAIConverter.js'"
check "tooluse" "geminiToAntigravity in antigravity-core.js" \
  "grep -q 'geminiToAntigravity' '$SRC/providers/gemini/antigravity-core.js'"
check "tooluse" "buildCodewhispererRequest in claude-kiro.js ~:1047" \
  "grep -n 'buildCodewhispererRequest' '$SRC/providers/claude/claude-kiro.js' | awk -F: '{if(\$1>=1020 && \$1<=1080) found=1} END{exit !found}'"
check "tooluse" "tools without descriptions dropped at kiro :1169" \
  "grep -n 'description' '$SRC/providers/claude/claude-kiro.js' | awk -F: '{if(\$1>=1150 && \$1<=1200) found=1} END{exit !found}'"

# ── aiclient-preflight ────────────────────────────────────────────────────────
echo ""
echo "[ aiclient-preflight ]"
check "preflight" "registerAdapter calls in adapter.js:704+" \
  "grep -n 'registerAdapter' '$SRC/providers/adapter.js' | sed -n '2p' | grep -q '704:'"
check "preflight" "getServiceAdapter in adapter.js:771" \
  "grep -n 'getServiceAdapter' '$SRC/providers/adapter.js' | head -1 | grep -q '771:'"
check "preflight" "registerAllConverters in register-converters.js" \
  "grep -q 'registerAllConverters' '$SRC/converters/register-converters.js'"
check "preflight" "flattenToolArguments exported from converters/utils.js" \
  "grep -q 'export.*flattenToolArguments\|flattenToolArguments.*export' '$SRC/converters/utils.js'"
check "preflight" "request-handlers.js exists (🟡 High risk)" \
  "test -f '$SRC/utils/request-handlers.js'"
check "preflight" "error-handling.js exists (🟡 High risk)" \
  "test -f '$SRC/utils/error-handling.js'"
check "preflight" "cooldown-manager.js exists (🟡 High risk)" \
  "test -f '$SRC/providers/cooldown-manager.js'"
check "preflight" "common.js is a barrel (≤15 lines)" \
  "[ \$(wc -l < '$SRC/utils/common.js') -le 15 ]"

# ── aiclient-providers ────────────────────────────────────────────────────────
echo ""
echo "[ aiclient-providers ]"
check "providers" "registerAdapter calls in adapter.js:704+" \
  "grep -n 'registerAdapter' '$SRC/providers/adapter.js' | sed -n '2p' | grep -q '704:'"
check "providers" "refreshToken check in provider-pool-manager.js:516+" \
  "grep -n 'refreshToken' '$SRC/providers/provider-pool-manager.js' | awk -F: '{if(\$1>=505 && \$1<=545) found=1} END{exit !found}'"
check "providers" "DEFAULT_HEALTH_CHECK_MODELS in provider-pool-manager.js:67" \
  "grep -n 'DEFAULT_HEALTH_CHECK_MODELS' '$SRC/providers/provider-pool-manager.js' | head -1 | grep -q '67:'"
check "providers" "PROVIDER_MAPPINGS in provider-utils.js:14" \
  "grep -n 'PROVIDER_MAPPINGS' '$SRC/utils/provider-utils.js' | head -1 | grep -q '14:'"
check "providers" "normalizeConfiguredProviders in config-manager.js:12" \
  "grep -n 'normalizeConfiguredProviders' '$SRC/core/config-manager.js' | head -1 | grep -q '12:'"
check "providers" "OpenAIConverter.js exists" \
  "test -f '$SRC/converters/strategies/OpenAIConverter.js'"
check "providers" "ClaudeConverter.js exists" \
  "test -f '$SRC/converters/strategies/ClaudeConverter.js'"

# ── aiclient-credentials ──────────────────────────────────────────────────────
echo ""
echo "[ aiclient-credentials ]"
check "credentials" "refreshToken check in provider-pool-manager.js:516+" \
  "grep -n 'refreshToken' '$SRC/providers/provider-pool-manager.js' | awk -F: '{if(\$1>=505 && \$1<=545) found=1} END{exit !found}'"
check "credentials" "codex-oauth.js exists (OAuth-but-no-needsReauth)" \
  "test -f '$SRC/auth/codex-oauth.js'"

# ── Modular Architecture ─────────────────────────────────────────────────────
# Assertions for the 5 focused modules extracted from common.js (May 17 decomposition)
echo ""
echo "[ modular-architecture ]"
check "modular" "error-handling.js exists" \
  "test -f '$SRC/utils/error-handling.js'"
check "modular" "cooldown-manager.js exists" \
  "test -f '$SRC/providers/cooldown-manager.js'"
check "modular" "request-handlers.js exists" \
  "test -f '$SRC/utils/request-handlers.js'"
check "modular" "network-utils.js exists" \
  "test -f '$SRC/utils/network-utils.js'"
check "modular" "common.js is a barrel (re-exports only, ≤15 lines)" \
  "[ \$(wc -l < '$SRC/utils/common.js') -le 15 ] && grep -q 'export' '$SRC/utils/common.js'"
check "modular" "error-handling.js exports handleError" \
  "grep -q 'export function handleError' '$SRC/utils/error-handling.js'"
check "modular" "error-handling.js exports createErrorResponse" \
  "grep -q 'export function createErrorResponse' '$SRC/utils/error-handling.js'"
check "modular" "cooldown-manager.js exports CooldownManager class" \
  "grep -q 'export class CooldownManager' '$SRC/providers/cooldown-manager.js'"
check "modular" "cooldown-manager.js contains cooldown logic" \
  "grep -qi 'cooldown' '$SRC/providers/cooldown-manager.js'"
check "modular" "network-utils.js exports sharedHttpAgent" \
  "grep -q 'export.*sharedHttpAgent' '$SRC/utils/network-utils.js'"
check "modular" "network-utils.js exports isRetryableNetworkError" \
  "grep -q 'export function isRetryableNetworkError' '$SRC/utils/network-utils.js'"
check "modular" "cockpit-quota.js exports getQuotaPenalty" \
  "grep -q 'export function getQuotaPenalty' '$SRC/utils/cockpit-quota.js'"
check "modular" "cockpit-quota.js exports start" \
  "grep -q 'export function start' '$SRC/utils/cockpit-quota.js'"
check "modular" "cockpit-quota imported in provider-pool-manager.js" \
  "grep -q 'cockpit-quota' '$SRC/providers/provider-pool-manager.js'"
check "modular" "cockpitQuota.start() called in api-server.js" \
  "grep -q 'cockpitQuota.start' '$SRC/services/api-server.js'"

# ── New provider coverage (aiclient-models, aiclient-routing, aiclient-tooluse) ──
echo ""
echo "[ new-provider-coverage ]"
check "aiclient-models" "openai-iflow documented in aiclient-models/SKILL.md" \
  "grep -q 'openai-iflow' '/Users/ilialiston/AIClient2API/.claude/skills/aiclient-models/SKILL.md'"
check "aiclient-models" "openai-qwen-oauth documented in aiclient-models/SKILL.md" \
  "grep -q 'openai-qwen-oauth' '/Users/ilialiston/AIClient2API/.claude/skills/aiclient-models/SKILL.md'"
check "aiclient-routing" "grok-web fallback present in aiclient-routing/SKILL.md" \
  "grep -q 'grok-web' '/Users/ilialiston/AIClient2API/.claude/skills/aiclient-routing/SKILL.md'"
check "aiclient-tooluse" "GrokConverter documented in aiclient-tooluse/SKILL.md" \
  "grep -q 'GrokConverter' '/Users/ilialiston/AIClient2API/.claude/skills/aiclient-tooluse/SKILL.md'"
check "aiclient-tooluse" "CodexConverter documented in aiclient-tooluse/SKILL.md" \
  "grep -q 'CodexConverter' '/Users/ilialiston/AIClient2API/.claude/skills/aiclient-tooluse/SKILL.md'"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "================================================"
echo "  PASSED: $PASS   FAILED: $FAIL"
echo "================================================"
echo ""

if [ $FAIL -gt 0 ]; then
  echo "ACTION REQUIRED: Run /aiclient-sync and load superpowers:writing-skills"
  echo "to fix each ❌ before the skills are considered accurate."
  echo ""
  exit 1
fi
