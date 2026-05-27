/**
 * 转换器公共工具函数模块
 * 提供各种协议转换所需的通用辅助函数
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';

// =============================================================================
// 常量定义
// =============================================================================

// Anthropic built-in tool types (computer_use, bash, text_editor, web_search) have no input_schema —
// they cannot be forwarded to non-Anthropic backends and must be filtered out.
export const ANTHROPIC_BUILTIN_TOOL_TYPES = /^(computer|bash|text_editor|web_search)_\d+$/;
export function isAnthropicBuiltinTool(tool) {
    return !!(tool && typeof tool.type === 'string' && ANTHROPIC_BUILTIN_TOOL_TYPES.test(tool.type));
}

// 通用默认值
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TEMPERATURE = 1;
export const DEFAULT_TOP_P = 0.95;

// =============================================================================
// OpenAI 相关常量
// =============================================================================
export const OPENAI_DEFAULT_MAX_TOKENS = 128000;
export const OPENAI_DEFAULT_TEMPERATURE = 1;
export const OPENAI_DEFAULT_TOP_P = 0.95;
export const OPENAI_DEFAULT_INPUT_TOKEN_LIMIT = 32768;
export const OPENAI_DEFAULT_OUTPUT_TOKEN_LIMIT = 128000;

// =============================================================================
// Claude 相关常量
// =============================================================================
export const CLAUDE_DEFAULT_MAX_TOKENS = 1000000;
export const CLAUDE_DEFAULT_TEMPERATURE = 1;
export const CLAUDE_DEFAULT_TOP_P = 0.95;

// =============================================================================
// Gemini 相关常量
// =============================================================================
export const GEMINI_DEFAULT_MAX_TOKENS = 65534;
export const GEMINI_DEFAULT_TEMPERATURE = 1;
export const GEMINI_DEFAULT_TOP_P = 0.95;
export const GEMINI_DEFAULT_INPUT_TOKEN_LIMIT = 1000000;
export const GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT = 65534;

// =============================================================================
// OpenAI Responses 相关常量
// =============================================================================
export const OPENAI_RESPONSES_DEFAULT_MAX_TOKENS = 128000;
export const OPENAI_RESPONSES_DEFAULT_TEMPERATURE = 1;
export const OPENAI_RESPONSES_DEFAULT_TOP_P = 0.95;
export const OPENAI_RESPONSES_DEFAULT_INPUT_TOKEN_LIMIT = 32768;
export const OPENAI_RESPONSES_DEFAULT_OUTPUT_TOKEN_LIMIT = 128000;

// =============================================================================
// 每模型最大输出 token 数 (max output tokens per model)
// Used to inject accurate per-model defaults when clients omit max_tokens.
// Values sourced from provider API docs / listModels() introspection.
// =============================================================================
export const MODEL_MAX_OUTPUT_TOKENS = {
    // Gemini CLI OAuth models — API reports outputTokenLimit: 65535
    'gemini-3.1-pro-preview': 65535,
    'gemini-3-flash-preview': 65535,
    'gemini-3.1-flash-lite-preview': 65535,
    'gemini-2.5-pro': 65535,
    'gemini-2.5-flash': 65535,
    'gemini-2.5-flash-lite': 65535,
    // Gemini Antigravity models
    'gemini-3-flash': 65535,
    'gemini-3.1-pro-high': 65535,
    'gemini-3.1-pro-low': 65535,
    'gemini-3.5-flash-extra-low': 65535,
    'gemini-3.5-flash-low': 65535,
    'gemini-3.5-flash-medium': 65535,   // alias → gemini-3.5-flash-low
    'gemini-3.5-flash-high': 65535,     // alias → gemini-3-flash-agent
    'gemini-3.1-flash-image': 65535,
    'gemini-3-flash-agent': 65535,
    'gemini-2.5-flash-thinking': 65535,
    // Antigravity Claude-via-Gemini models
    'gemini-claude-sonnet-4-6': 64000,
    'gemini-claude-opus-4-6-thinking': 32000,
    // Kiro / Anthropic Claude models
    'claude-haiku-4-5': 32000,
    'claude-sonnet-4-5': 64000,
    'claude-sonnet-4-5-20250929': 64000,
    'claude-sonnet-4-6': 64000,
    'claude-opus-4-5': 32000,
    'claude-opus-4-6': 32000,
    'claude-opus-4-7': 32000,
    // OpenAI Codex OAuth
    'gpt-5.2': 32768,
    'gpt-5.3-codex': 32768,
    'gpt-5.4': 32768,
    'gpt-5.4-mini': 32768,
    'gpt-5.5': 32768,
    // GitHub Models
    'gpt-4o': 16384,
    'gpt-4o-mini': 16384,
    'gpt-4.1': 32768,
    'gpt-4.1-mini': 32768,
    'gpt-4.1-nano': 32768,
    'DeepSeek-R1': 32768,
    // NVIDIA NIM
    'nvidia/llama-3.3-nemotron-super-49b-v1.5': 131072,
    'nvidia/llama-3.3-nemotron-super-49b-v1': 131072,
    'meta/llama-4-maverick-17b-128e-instruct': 8192,
    'meta/llama-3.3-70b-instruct': 131072,
    'moonshotai/kimi-k2.6': 32768,
    'mistralai/mistral-small-4-119b-2603': 32768,
    'openai/gpt-oss-120b': 32768,
    // OpenRouter free-tier models (base IDs after :free suffix is stripped)
    'openai/gpt-oss-20b': 16384,
    'deepseek/deepseek-v4-flash': 32768,
    'nvidia/nemotron-3-super-120b-a12b': 131072,
    'nvidia/nemotron-3-nano-30b-a3b': 131072,
};

// =============================================================================
// 每模型输入上下文窗口大小 (input context window per model)
// Used by the status line to show accurate "left" context relative to the
// actual model in use, not Claude Code's assumed context size.
// =============================================================================
export const MODEL_CONTEXT_WINDOWS = {
    // Gemini models — 1M input context (API reports inputTokenLimit: 1024000)
    'gemini-3.1-pro-preview': 1048576,
    'gemini-3-flash-preview': 1048576,
    'gemini-3.1-flash-lite-preview': 1048576,
    'gemini-2.5-pro': 1048576,
    'gemini-2.5-flash': 1048576,
    'gemini-2.5-flash-lite': 1048576,
    'gemini-3-flash': 1048576,
    'gemini-3.1-pro-high': 1048576,
    'gemini-3.1-pro-low': 1048576,
    'gemini-3.5-flash-extra-low': 1048576,
    'gemini-3.5-flash-low': 1048576,
    'gemini-3.5-flash-medium': 1048576,   // alias → gemini-3.5-flash-low
    'gemini-3.5-flash-high': 1048576,     // alias → gemini-3-flash-agent
    'gemini-3.1-flash-image': 1048576,
    'gemini-3-flash-agent': 1048576,
    'gemini-2.5-flash-thinking': 1048576,
    'gemini-claude-sonnet-4-6': 200000,
    'gemini-claude-opus-4-6-thinking': 200000,
    // Kiro / Anthropic Claude models
    'claude-haiku-4-5': 200000,
    'claude-sonnet-4-5': 200000,
    'claude-sonnet-4-5-20250929': 200000,
    'claude-sonnet-4-6': 200000,
    'claude-opus-4-5': 1000000,
    'claude-opus-4-6': 1000000,
    'claude-opus-4-7': 1000000,
    // OpenAI Codex OAuth
    'gpt-5.2': 128000,
    'gpt-5.3-codex': 128000,
    'gpt-5.4': 128000,
    'gpt-5.4-mini': 128000,
    'gpt-5.5': 128000,
    // GitHub Models
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4.1': 1000000,
    'gpt-4.1-mini': 1000000,
    'gpt-4.1-nano': 1000000,
    'DeepSeek-R1': 128000,
    // NVIDIA NIM
    'nvidia/llama-3.3-nemotron-super-49b-v1.5': 131072,
    'nvidia/llama-3.3-nemotron-super-49b-v1': 131072,
    'meta/llama-4-maverick-17b-128e-instruct': 1048576,
    'meta/llama-3.3-70b-instruct': 131072,
    'moonshotai/kimi-k2.6': 131072,
    'mistralai/mistral-small-4-119b-2603': 131072,
    'openai/gpt-oss-120b': 128000,
    // OpenRouter free-tier models (base IDs after :free suffix is stripped)
    'openai/gpt-oss-20b': 128000,
    'deepseek/deepseek-v4-flash': 128000,
    'nvidia/nemotron-3-super-120b-a12b': 128000,
    'nvidia/nemotron-3-nano-30b-a3b': 128000,
};

/**
 * Returns the max output tokens for a model, falling back to a protocol default.
 * @param {string} modelId
 * @param {number} fallback - Protocol-level default to use when model is not in the map
 * @returns {number}
 */
export function getModelMaxOutputTokens(modelId, fallback) {
    return MODEL_MAX_OUTPUT_TOKENS[modelId] ?? fallback;
}

/**
 * Returns the input context window size for a model.
 * @param {string} modelId
 * @param {number} [fallback=200000]
 * @returns {number}
 */
export function getModelContextWindow(modelId, fallback = 200000) {
    return MODEL_CONTEXT_WINDOWS[modelId] ?? fallback;
}

// =============================================================================
// 通用辅助函数
// =============================================================================

/**
 * 判断值是否为 undefined 或 0，并返回默认值
 * @param {*} value - 要检查的值
 * @param {*} defaultValue - 默认值
 * @returns {*} 处理后的值
 */
export function checkAndAssignOrDefault(value, defaultValue) {
    if (value !== undefined && value !== 0) {
        return value;
    }
    return defaultValue;
}

/**
 * 生成唯一ID
 * @param {string} prefix - ID前缀
 * @returns {string} 生成的ID
 */
export function generateId(prefix = '') {
    return prefix ? `${prefix}_${uuidv4()}` : uuidv4();
}

/**
 * 安全解析JSON字符串
 * @param {string} str - JSON字符串
 * @returns {*} 解析后的对象或原始字符串
 */
export function safeParseJSON(str) {
    if (!str) {
        return str;
    }
    let cleanedStr = str;

    // 处理可能被截断的转义序列
    if (cleanedStr.endsWith('\\') && !cleanedStr.endsWith('\\\\')) {
        cleanedStr = cleanedStr.substring(0, cleanedStr.length - 1);
    } else if (cleanedStr.endsWith('\\u') || cleanedStr.endsWith('\\u0') || cleanedStr.endsWith('\\u00')) {
        const idx = cleanedStr.lastIndexOf('\\u');
        cleanedStr = cleanedStr.substring(0, idx);
    }

    try {
        return JSON.parse(cleanedStr || '{}');
    } catch (e) {
        return str;
    }
}

/**
 * 提取消息内容中的文本
 * @param {string|Array} content - 消息内容
 * @returns {string} 提取的文本
 */
export function extractTextFromMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

/**
 * 应用系统提示词内容替换
 * @param {string} content - 原始内容
 * @param {Array} replacements - 替换规则数组
 * @returns {string} 替换后的内容
 */
export function applySystemPromptReplacements(content, replacements = []) {
    if (!content || !replacements || !Array.isArray(replacements) || replacements.length === 0) {
        return content;
    }
    let newContent = content;
    for (const replacement of replacements) {
        if (replacement.old !== undefined && replacement.new !== undefined) {
            if (typeof replacement.old === 'string') {
                // 简单字符串全量替换
                newContent = newContent.split(replacement.old).join(replacement.new);
            } else if (replacement.old instanceof RegExp || (typeof replacement.old === 'object' && replacement.old !== null)) {
                // 正则表达式替换
                newContent = newContent.replace(replacement.old, replacement.new);
            }
        }
    }
    return newContent;
}

/**
 * 提取并处理系统消息
 * @param {Array} messages - 消息数组
 * @param {Array} replacements - 替换规则数组，可选
 * @returns {{systemInstruction: Object|null, nonSystemMessages: Array}}
 */
export function extractAndProcessSystemMessages(messages, replacements = []) {
    const systemContents = [];
    const nonSystemMessages = [];

    for (const message of messages) {
        if (message.role === 'system' || message.role === 'developer') {
            let content = extractTextFromMessageContent(message.content);

            // 应用系统提示词内容替换
            content = applySystemPromptReplacements(content, replacements);

            systemContents.push(content);
        } else {
            nonSystemMessages.push(message);
        }
    }

    let systemInstruction = null;
    if (systemContents.length > 0) {
        systemInstruction = {
            parts: [{
                text: systemContents.join('\n')
            }]
        };
    }
    return { systemInstruction, nonSystemMessages };
}

// =============================================================================
// Schema normalization cache — avoids redundant recursive walks for identical
// tool schemas. Claude Code tools (Agent, Bash, Read, etc.) have identical
// schemas on every call, so this eliminates the per-request recursion cost.
// =============================================================================
const _schemaCache = new Map();
const _schemaCacheKeys = [];
const SCHEMA_CACHE_MAX = 200;

function _cachedSchemaOp(cacheKey, fn) {
    const cached = _schemaCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = fn();
    if (_schemaCacheKeys.length >= SCHEMA_CACHE_MAX) {
        _schemaCache.delete(_schemaCacheKeys.shift());
    }
    _schemaCache.set(cacheKey, result);
    _schemaCacheKeys.push(cacheKey);
    return result;
}

// JSON Schema 清理配置常量
const GEMINI_ALLOWED_KEYS = [
    "type",
    "description",
    "properties",
    "required",
    "enum",
    "items",
    "nullable"
];

const OPENAI_EXCLUDED_KEYS = ['$schema'];

/**
 * 规范化 type 字段值
 * @param {string|Array} typeValue - type 字段的原始值
 * @param {Function} caseTransform - 大小写转换函数 (toUpperCase 或 toLowerCase)
 * @returns {string|undefined} 规范化后的 type 值
 */
function normalizeTypeField(typeValue, caseTransform) {
    if (Array.isArray(typeValue)) {
        const actualType = typeValue.find(t => t !== 'null');
        return actualType ? caseTransform(actualType) : undefined;
    }

    if (typeof typeValue === 'string') {
        return caseTransform(typeValue);
    }

    return undefined;
}

/**
 * 递归清理 properties 对象
 * @param {Object} properties - properties 对象
 * @param {Function} cleanFn - 清理函数
 * @returns {Object} 清理后的 properties
 */
function cleanPropertiesRecursively(properties, cleanFn) {
    const cleaned = {};
    for (const [propName, propSchema] of Object.entries(properties)) {
        cleaned[propName] = cleanFn(propSchema);
    }
    return cleaned;
}

/**
 * 处理 type 字段（Gemini 格式）
 * @param {Object} sanitized - 目标对象
 * @param {string|Array} typeValue - type 字段值
 */
function handleGeminiTypeField(sanitized, typeValue) {
    if (Array.isArray(typeValue) && typeValue.includes('null')) {
        sanitized.nullable = true;
    }

    const normalizedType = normalizeTypeField(typeValue, t => t.toUpperCase());
    if (normalizedType) {
        sanitized.type = normalizedType;
    }
}

/**
 * 处理 type 字段（OpenAI 格式）
 * @param {Object} sanitized - 目标对象
 * @param {string|Array} typeValue - type 字段值
 */
function handleOpenAITypeField(sanitized, typeValue) {
    if (Array.isArray(typeValue)) {
        sanitized.type = typeValue.map(t => t.toLowerCase());
    } else if (typeof typeValue === 'string') {
        sanitized.type = typeValue.toLowerCase();
    }
}

/**
 * 通用 JSON Schema 清理函数
 * @param {Object} schema - JSON Schema
 * @param {Object} options - 清理选项
 * @param {Array} options.allowedKeys - 允许的键白名单（可选）
 * @param {Array} options.excludedKeys - 排除的键黑名单（可选）
 * @param {Function} options.typeHandler - type 字段处理函数
 * @param {Function} recursiveFn - 递归调用的函数
 * @returns {Object} 清理后的 JSON Schema
 */
function cleanJsonSchemaGeneric(schema, options, recursiveFn) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => recursiveFn(item));
    }

    const { allowedKeys, excludedKeys, typeHandler } = options;
    const sanitized = {};

    for (const [key, value] of Object.entries(schema)) {
        // 应用黑名单过滤
        if (excludedKeys && excludedKeys.includes(key)) {
            continue;
        }

        // 应用白名单过滤
        if (allowedKeys && !allowedKeys.includes(key)) {
            continue;
        }

        // 处理 properties
        if (key === 'properties' && typeof value === 'object' && value !== null) {
            sanitized[key] = cleanPropertiesRecursively(value, recursiveFn);
            continue;
        }

        // 处理 items
        if (key === 'items') {
            sanitized[key] = recursiveFn(value);
            continue;
        }

        // 处理 type
        if (key === 'type') {
            typeHandler(sanitized, value);
            continue;
        }

        // 其他属性直接复制
        sanitized[key] = value;
    }

    return sanitized;
}

/**
 * 清理JSON Schema属性（移除Gemini不支持的属性）
 * Google Gemini API 只支持有限的 JSON Schema 属性，不支持以下属性：
 * - exclusiveMinimum, exclusiveMaximum, minimum, maximum
 * - minLength, maxLength, minItems, maxItems
 * - pattern, format, default, const
 * - additionalProperties, $schema, $ref, $id
 * - allOf, anyOf, oneOf, not
 * @param {Object} schema - JSON Schema
 * @returns {Object} 清理后的JSON Schema
 */
export function cleanJsonSchemaProperties(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const cacheKey = `props:${JSON.stringify(schema)}`;
    return _cachedSchemaOp(cacheKey, () => cleanJsonSchemaGeneric(
        schema,
        {
            allowedKeys: GEMINI_ALLOWED_KEYS,
            typeHandler: handleGeminiTypeField
        },
        cleanJsonSchemaProperties
    ));
}

/**
 * 清理JSON Schema属性（用于OpenAI格式）
 * OpenAI API 要求标准的 JSON Schema 格式，type 字段必须是小写
 * 移除不必要的属性：$schema, additionalProperties 等
 * @param {Object} schema - JSON Schema
 * @returns {Object} 清理后的JSON Schema
 */
export function cleanJsonSchemaForOpenAI(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const cacheKey = `oai:${JSON.stringify(schema)}`;
    return _cachedSchemaOp(cacheKey, () => cleanJsonSchemaGeneric(
        schema,
        {
            excludedKeys: OPENAI_EXCLUDED_KEYS,
            typeHandler: handleOpenAITypeField
        },
        cleanJsonSchemaForOpenAI
    ));
}

/**
 * 映射结束原因
 * @param {string} reason - 结束原因
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @returns {string} 映射后的结束原因
 */
export function mapFinishReason(reason, sourceFormat, targetFormat) {
    const reasonMappings = {
        openai: {
            anthropic: {
                stop: "end_turn",
                length: "max_tokens",
                content_filter: "stop_sequence",
                tool_calls: "tool_use"
            }
        },
        gemini: {
            anthropic: {
                STOP: "end_turn",
                MAX_TOKENS: "max_tokens",
                SAFETY: "stop_sequence",
                RECITATION: "stop_sequence",
                stop: "end_turn",
                length: "max_tokens",
                safety: "stop_sequence",
                recitation: "stop_sequence",
                other: "end_turn"
            }
        }
    };

    try {
        return reasonMappings[sourceFormat][targetFormat][reason] || "end_turn";
    } catch (e) {
        return "end_turn";
    }
}

/**
 * 根据budget_tokens智能判断OpenAI reasoning_effort等级
 * @param {number|null} budgetTokens - Anthropic thinking的budget_tokens值
 * @returns {string} OpenAI reasoning_effort等级
 */
export function determineReasoningEffortFromBudget(budgetTokens) {
    if (budgetTokens === null || budgetTokens === undefined) {
        logger.info("No budget_tokens provided, defaulting to reasoning_effort='high'");
        return "high";
    }

    const LOW_THRESHOLD = 50;
    const HIGH_THRESHOLD = 200;

    logger.debug(`Threshold configuration: low <= ${LOW_THRESHOLD}, medium <= ${HIGH_THRESHOLD}, high > ${HIGH_THRESHOLD}`);

    let effort;
    if (budgetTokens <= LOW_THRESHOLD) {
        effort = "low";
    } else if (budgetTokens <= HIGH_THRESHOLD) {
        effort = "medium";
    } else {
        effort = "high";
    }

    logger.info(`🎯 Budget tokens ${budgetTokens} -> reasoning_effort '${effort}' (thresholds: low<=${LOW_THRESHOLD}, high<=${HIGH_THRESHOLD})`);
    return effort;
}

/**
 * 从OpenAI文本中提取thinking内容
 * @param {string} text - 文本内容
 * @returns {string|Array} 提取后的内容
 */
export function extractThinkingFromOpenAIText(text) {
    const thinkingPattern = /<thinking>\s*(.*?)\s*<\/thinking>/gs;
    const matches = [...text.matchAll(thinkingPattern)];

    const contentBlocks = [];
    let lastEnd = 0;

    for (const match of matches) {
        const beforeText = text.substring(lastEnd, match.index).trim();
        if (beforeText) {
            contentBlocks.push({
                type: "text",
                text: beforeText
            });
        }

        const thinkingText = match[1].trim();
        if (thinkingText) {
            contentBlocks.push({
                type: "thinking",
                thinking: thinkingText
            });
        }

        lastEnd = match.index + match[0].length;
    }

    const afterText = text.substring(lastEnd).trim();
    if (afterText) {
        contentBlocks.push({
            type: "text",
            text: afterText
        });
    }

    if (contentBlocks.length === 0) {
        return text;
    }

    if (contentBlocks.length === 1 && contentBlocks[0].type === "text") {
        return contentBlocks[0].text;
    }

    return contentBlocks;
}

// =============================================================================
// 工具状态管理器（单例模式）
// =============================================================================

/**
 * 全局工具状态管理器（带 LRU 上限防止内存泄漏）
 */
class ToolStateManager {
    constructor() {
        if (ToolStateManager.instance) {
            return ToolStateManager.instance;
        }
        ToolStateManager.instance = this;
        this._toolMappings = {};
        this._toolSchemas = {};
        this._mappingKeys = []; // LRU tracking for mappings
        this._maxMappings = 1000;
        return this;
    }

    storeToolMapping(funcName, toolId) {
        // LRU eviction: if at cap and key is new, remove oldest
        if (!(funcName in this._toolMappings) && this._mappingKeys.length >= this._maxMappings) {
            const oldest = this._mappingKeys.shift();
            delete this._toolMappings[oldest];
        }
        // Update or insert
        this._toolMappings[funcName] = toolId;
        const idx = this._mappingKeys.indexOf(funcName);
        if (idx !== -1) this._mappingKeys.splice(idx, 1);
        this._mappingKeys.push(funcName);
    }

    storeToolSchema(funcName, schema) {
        this._toolSchemas[funcName] = schema;
    }

    getToolId(funcName) {
        return this._toolMappings[funcName] || null;
    }

    getToolSchema(funcName) {
        return this._toolSchemas[funcName] || null;
    }

    clearMappings() {
        this._toolMappings = {};
        this._toolSchemas = {};
        this._mappingKeys = [];
    }
}

export const toolStateManager = new ToolStateManager();

/**
 * Dynamically flattens object-valued arguments to JSON strings based on schema definitions.
 * Prevents "invalid tool parameters" errors when non-Claude models return nested objects
 * for properties defined as strings.
 */
export function dynamicFlattenToolArguments(toolName, input, schema) {
    if (!input || typeof input !== 'object') return input;

    // Use provided schema or try to find it in the manager
    const effectiveSchema = schema || toolStateManager.getToolSchema(toolName);
    if (!effectiveSchema || !effectiveSchema.properties) {
        // Fallback to legacy hardcoded flattening if no schema is available
        return flattenToolArguments(toolName, input);
    }

    const flattened = { ...input };
    const properties = effectiveSchema.properties;

    for (const [key, value] of Object.entries(flattened)) {
        const propSchema = properties[key];
        if (!propSchema) continue;

        // If the schema says it should be a string, but we got an object/array, stringify it.
        if (propSchema.type === 'string' && value !== null && typeof value === 'object') {
            logger.info(`[Dynamic Schema Guard] Stringifying ${key} for tool ${toolName} (type mismatch: expected string, got ${Array.isArray(value) ? 'array' : 'object'})`);
            flattened[key] = JSON.stringify(value);
        }
    }

    return flattened;
}

/**
 * Flattens object-valued arguments to JSON strings for tools that expect string inputs.
 * Prevents "invalid tool parameters" errors when non-Claude models return nested objects.
 * @deprecated Use dynamicFlattenToolArguments for schema-aware flattening.
 */
export function flattenToolArguments(toolName, input) {
    if (!input || typeof input !== 'object') return input;

    // Legacy hardcoded tool guard list
    const SCHEMA_GUARD_TOOLS = new Set(['Skill', 'Agent', 'Bash', 'mcp__ide__executeCode']);
    const SCHEMA_GUARD_FIELDS = ['args', 'prompt', 'command', 'code'];

    if (!SCHEMA_GUARD_TOOLS.has(toolName)) return input;

    const flattened = { ...input };
    for (const field of SCHEMA_GUARD_FIELDS) {
        if (flattened[field] && typeof flattened[field] === 'object') {
            logger.info(`[Schema Guard] Flattening ${field} for tool ${toolName}`);
            flattened[field] = JSON.stringify(flattened[field]);
        }
    }
    return flattened;
}
