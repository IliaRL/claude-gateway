
import { atomicWriteFile } from '../../utils/file-lock.js';
import { OAuth2Client } from 'google-auth-library';
import logger from '../../utils/logger.js';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import open from 'open';
import { configureTLSSidecar } from '../../utils/proxy-utils.js';
import { formatExpiryTime, isRetryableNetworkError, formatExpiryLog } from '../../utils/common.js';
import { getProviderModels } from '../provider-models.js';
import { handleGeminiAntigravityOAuth } from '../../auth/oauth-handlers.js';
import { getProxyConfigForProvider, getGoogleAuthProxyConfig, isTLSSidecarEnabledForProvider } from '../../utils/proxy-utils.js';
import { cleanJsonSchemaProperties } from '../../converters/utils.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { MODEL_PROVIDER } from '../../utils/common.js';
import { normalizeAntigravityToolConfig } from './antigravity-tool-config.js';

// --- Constants ---
const CREDENTIALS_DIR = '.antigravity';
const CREDENTIALS_FILE = 'oauth_creds.json';

// Base URLs
const ANTIGRAVITY_BASE_URL_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_BASE_URL_PROD = 'https://cloudcode-pa.googleapis.com';

const ANTIGRAVITY_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const DEFAULT_USER_AGENT = 'antigravity/1.104.0 darwin/arm64';
const REFRESH_SKEW = 3000; // 3000秒（50分钟）提前刷新Token

const ANTIGRAVITY_SYSTEM_PROMPT = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**`;


// Thinking 配置相关常量
const DEFAULT_THINKING_MIN = 1024;
const DEFAULT_THINKING_MAX = 100000;
const ANTIGRAVITY_EMPTY_TEXT_PLACEHOLDER = '.';

// 获取 Antigravity 模型列表
const ANTIGRAVITY_MODELS = getProviderModels(MODEL_PROVIDER.ANTIGRAVITY);

const ANTIGRAVITY_CLIENT_TO_UPSTREAM_MODEL = {
    'gemini-3.1-pro-high': 'gemini-pro-agent',
    'gemini-3.1-pro-preview': 'gemini-pro-agent',
};

const ANTIGRAVITY_UPSTREAM_TO_CLIENT_MODELS = {
    'gemini-pro-agent': ['gemini-3.1-pro-high', 'gemini-3.1-pro-preview'],
};

const ANTIGRAVITY_CLIENT_MODEL_THINKING_LEVEL = {
    'gemini-pro-agent': 'high',
    'gemini-3.1-pro-high': 'high',
    'gemini-3.1-pro-preview': 'high',
    'gemini-3-pro-high': 'high',
    'gemini-3-pro-preview': 'high',
    'gemini-3.5-flash-high': 'high',
    'gemini-3.1-pro-low': 'low',
    'gemini-3-pro-low': 'low',
    'gemini-3.5-flash-low': 'low'
};

const ANTIGRAVITY_MODEL_METADATA = {
    'claude-opus-4-6-thinking': {
        maxOutputTokens: 64000,
        thinking: { min: 1024, max: 64000, zeroAllowed: true, dynamicAllowed: true }
    },
    'claude-sonnet-4-6': {
        maxOutputTokens: 64000,
        thinking: { min: 1024, max: 64000, zeroAllowed: true, dynamicAllowed: true }
    },
    'gemini-3-flash': {
        maxOutputTokens: 65536,
        thinking: { min: 128, max: 32768, dynamicAllowed: true, levels: ['minimal', 'low', 'medium', 'high'] }
    },
    'gemini-3-flash-agent': {
        maxOutputTokens: 65536,
        thinking: { min: 128, max: 32768, dynamicAllowed: true, levels: ['minimal', 'low', 'medium', 'high'] }
    },
    'gemini-3-pro-high': {
        maxOutputTokens: 65535,
        thinking: { min: 128, max: 32768, dynamicAllowed: true, levels: ['low', 'high'] }
    },
    'gemini-3-pro-low': {
        maxOutputTokens: 65535,
        thinking: { min: 128, max: 32768, dynamicAllowed: true, levels: ['low', 'high'] }
    },
    'gemini-3.1-flash-image': {
        thinking: { min: 128, max: 32768, dynamicAllowed: true, levels: ['minimal', 'high'] }
    },
    'gemini-pro-agent': {
        maxOutputTokens: 65535,
        thinking: { min: 1, max: 65535, dynamicAllowed: true, levels: ['low', 'medium', 'high'] }
    },
    'gemini-3.1-pro-high': {
        maxOutputTokens: 65535,
        thinking: { min: 1, max: 65535, dynamicAllowed: true, levels: ['low', 'medium', 'high'] }
    },
    'gemini-3.1-pro-low': {
        maxOutputTokens: 65535,
        thinking: { min: 1, max: 65535, dynamicAllowed: true, levels: ['low', 'medium', 'high'] }
    },
    'gpt-oss-120b-medium': {
        maxOutputTokens: 32768
    },
    'gemini-3.1-flash-lite': {
        maxOutputTokens: 65535,
        thinking: { min: 1, max: 65535, zeroAllowed: true, dynamicAllowed: true, levels: ['minimal', 'low', 'medium', 'high'] }
    },
    'gemini-3.5-flash-low': {
        maxOutputTokens: 65535,
        thinking: { min: 1, max: 65535, dynamicAllowed: true, levels: ['low', 'medium', 'high'] }
    }
};

function normalizeAntigravityModelId(modelName) {
    if (!modelName || typeof modelName !== 'string') return '';
    let normalized = modelName.trim();
    if (normalized.startsWith('models/')) {
        normalized = normalized.slice('models/'.length);
    }
    return normalized;
}

function stripModelSuffix(modelName) {
    const normalized = normalizeAntigravityModelId(modelName);
    const match = normalized.match(/^(.+?)\([^()]+\)$/);
    return match ? match[1].trim() : normalized;
}

function resolveAntigravityUpstreamModel(modelName) {
    const baseModel = stripModelSuffix(modelName);
    if (!baseModel) return '';
    if (baseModel.startsWith('gemini-claude-')) {
        return baseModel.replace('gemini-claude-', 'claude-');
    }
    return ANTIGRAVITY_CLIENT_TO_UPSTREAM_MODEL[baseModel] || baseModel;
}

function expandAntigravityClientModels(upstreamModel) {
    const baseModel = stripModelSuffix(upstreamModel);
    if (!baseModel) return [];
    const out = [];
    const push = (modelId) => {
        if (modelId && !out.includes(modelId)) out.push(modelId);
    };

    if (baseModel.startsWith('claude-')) {
        push(`gemini-${baseModel}`);
        return out;
    }

    let exposedAlias = false;
    for (const alias of ANTIGRAVITY_UPSTREAM_TO_CLIENT_MODELS[baseModel] || []) {
        if (ANTIGRAVITY_MODELS.includes(alias)) {
            push(alias);
            exposedAlias = true;
        }
    }
    if (ANTIGRAVITY_MODELS.includes(baseModel) || (!exposedAlias && ANTIGRAVITY_MODEL_METADATA[baseModel])) {
        push(baseModel);
    }
    return out;
}

function getAntigravityModelMetadata(modelName) {
    const upstreamModel = resolveAntigravityUpstreamModel(modelName);
    return ANTIGRAVITY_MODEL_METADATA[upstreamModel] || ANTIGRAVITY_MODEL_METADATA[stripModelSuffix(modelName)] || null;
}

function isKnownAntigravityModel(modelName) {
    const baseModel = stripModelSuffix(modelName);
    if (!baseModel) return false;
    return ANTIGRAVITY_MODELS.includes(baseModel) || !!getAntigravityModelMetadata(baseModel);
}

function antigravityModelUsesThinkingLevels(modelName) {
    const metadata = getAntigravityModelMetadata(modelName);
    return Array.isArray(metadata?.thinking?.levels) && metadata.thinking.levels.length > 0;
}

function antigravityModelRequiresStreamForNonStream(modelName) {
    const name = String(modelName || '').toLowerCase();
    return name.includes('claude') || name.includes('gemini-3-pro') || name.includes('gemini-3.1-flash-image');
}

function normalizeAntigravityTextPart(part) {
    if (!part || typeof part !== 'object' || !Object.prototype.hasOwnProperty.call(part, 'text')) {
        return;
    }

    if (typeof part.text !== 'string') {
        part.text = part.text == null ? '' : String(part.text);
    }

    // Antigravity 的 Claude 后端要求 text block 为非空白文本。
    if (part.text.trim().length === 0) {
        part.text = ANTIGRAVITY_EMPTY_TEXT_PLACEHOLDER;
    }
}

function normalizeAntigravityTextParts(parts) {
    if (!Array.isArray(parts)) return;
    parts.forEach(normalizeAntigravityTextPart);
}

function getAntigravityClientModelThinkingLevel(modelName) {
    const baseModel = stripModelSuffix(modelName);
    return ANTIGRAVITY_CLIENT_MODEL_THINKING_LEVEL[baseModel] || '';
}

function applyAntigravityThinkingLevelConfig(thinkingConfig, level) {
    thinkingConfig.thinkingLevel = level;
    thinkingConfig.includeThoughts = true;
    delete thinkingConfig.thinkingBudget;
    delete thinkingConfig.thinking_budget;
    return thinkingConfig;
}

function applyAntigravityClientModelThinkingLevel(payload, clientModelName) {
    const level = getAntigravityClientModelThinkingLevel(clientModelName);
    if (!level || !payload?.request) return payload;

    payload.request.generationConfig = payload.request.generationConfig || {};
    payload.request.generationConfig.thinkingConfig = payload.request.generationConfig.thinkingConfig || {};
    applyAntigravityThinkingLevelConfig(payload.request.generationConfig.thinkingConfig, level);
    return payload;
}

function applyAntigravityClientModelThinkingLevelToRequest(requestBody, clientModelName) {
    const level = getAntigravityClientModelThinkingLevel(clientModelName);
    if (!level || !requestBody) return requestBody;

    requestBody.generationConfig = requestBody.generationConfig || {};
    requestBody.generationConfig.thinkingConfig = requestBody.generationConfig.thinkingConfig || {};
    applyAntigravityThinkingLevelConfig(requestBody.generationConfig.thinkingConfig, level);
    return requestBody;
}


/**
 * 检查模型是否为 Claude 模型
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
function isClaude(modelName) {
    return modelName && modelName.toLowerCase().includes('claude');
}

/**
 * 检查是否为图像模型
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
function isImageModel(modelName) {
    return modelName && modelName.toLowerCase().includes('image');
}

/**
 * 检查模型是否支持 Thinking
 * @param {string} modelName - 模型名称
 * @returns {boolean}
 */
function modelSupportsThinking(modelName) {
    if (!modelName) return false;
    if (getAntigravityModelMetadata(modelName)?.thinking) return true;
    const name = modelName.toLowerCase();

    // 1. Explicit -thinking suffix (highest priority)
    if (name.includes('-thinking')) return true;

    // 2. Gemini models that support thinking
    if (name.startsWith('gemini-3') || name.startsWith('gemini-2.5-')) return true;

    // 3. Claude models: only Opus/Sonnet 4.6+ support thinking (Haiku never does)
    if (name.includes('claude')) {
        // Haiku never supports thinking
        if (name.includes('haiku')) return false;

        // Extract version numbers (e.g., "4-6" or "4-5")
        const versionMatch = name.match(/(\d+)-(\d+)/);
        if (versionMatch) {
            const major = parseInt(versionMatch[1], 10);
            const minor = parseInt(versionMatch[2], 10);

            // Opus and Sonnet 4.6+ support thinking
            if ((name.includes('opus') || name.includes('sonnet')) &&
                (major > 4 || (major === 4 && minor >= 6))) {
                return true;
            }
        }
    }

    return false;
}

/**
 * 生成随机请求ID
 * @returns {string}
 */
function generateRequestID() {
    return 'agent-' + uuidv4();
}

/**
 * 生成随机图像生成请求ID
 * @returns {string}
 */
function generateImageGenRequestID() {
    return `image_gen/${Date.now()}/${uuidv4()}/12`;
}

/**
 * 生成随机会话ID
 * @returns {string}
 */
function generateSessionID() {
    const n = Math.floor(Math.random() * 9000);
    return '-' + n.toString();
}

/**
 * 基于请求内容生成稳定的会话ID
 * 使用第一个用户消息的 SHA256 哈希值
 * @param {Object} payload - 请求体
 * @returns {string} 稳定的会话ID
 */
function generateStableSessionID(payload) {
    try {
        const contents = payload?.request?.contents;
        if (Array.isArray(contents)) {
            for (const content of contents) {
                if (content && content.role === 'user' && Array.isArray(content.parts)) {
                    const text = content.parts?.[0]?.text;
                    if (text) {
                        const hash = crypto.createHash('sha256').update(text).digest();
                        // 取前8字节转换为 BigInt，然后取正数
                        const n = hash.readBigUInt64BE(0) & BigInt('0x7FFFFFFFFFFFFFFF');
                        return '-' + n.toString();
                    }
                }
            }
        }
    } catch (e) {
        // 如果解析失败，回退到随机会话ID
    }
    return generateSessionID();
}

/**
 * 生成随机项目ID
 * @returns {string}
 */
function generateProjectID() {
    const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
    const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomPart = uuidv4().toLowerCase().substring(0, 5);
    return `${adj}-${noun}-${randomPart}`;
}

/**
 * 规范化 Thinking Budget
 * @param {string} modelName - 模型名称
 * @param {number} budget - 原始 budget 值
 * @returns {number} 规范化后的 budget
 */
function normalizeThinkingBudget(modelName, budget) {
    // -1 表示动态/无限制
    if (budget === -1) return -1;
    
    // 获取模型的 thinking 限制
    const thinking = getAntigravityModelMetadata(modelName)?.thinking || {};
    const min = thinking.min ?? DEFAULT_THINKING_MIN;
    const max = thinking.max ?? DEFAULT_THINKING_MAX;
    
    // 限制在有效范围内
    if (budget < min) return min;
    if (budget > max) return max;
    return budget;
}

/**
 * 规范化 Antigravity Thinking 配置
 * 对于 Claude 模型，确保 thinking budget < max_tokens
 * @param {string} modelName - 模型名称
 * @param {Object} payload - 请求体
 * @param {boolean} isClaudeModel - 是否为 Claude 模型
 * @returns {Object} 处理后的请求体
 */
function normalizeAntigravityThinking(modelName, payload, isClaudeModel) {
    // 如果模型不支持 thinking，移除 thinking 配置
    if (!modelSupportsThinking(modelName)) {
        if (payload?.request?.generationConfig?.thinkingConfig) {
            delete payload.request.generationConfig.thinkingConfig;
        }
        return payload;
    }
    
    const thinkingConfig = payload?.request?.generationConfig?.thinkingConfig;
    if (!thinkingConfig) return payload;
    
    const thinkingLevel = thinkingConfig.thinkingLevel;
    const budget = thinkingConfig.thinkingBudget;
    const thinkingRequested =
        thinkingLevel !== undefined ||
        (budget !== undefined && budget !== 0);

    // Antigravity 只有在 includeThoughts=true 时才会回传 thought parts。
    // 上游对 gemini-3 thinkingLevel 的请求不一定会显式带上这个字段，这里兜底补齐。
    if (thinkingRequested && thinkingConfig.includeThoughts === undefined) {
        thinkingConfig.includeThoughts = true;
    }

    if (budget === undefined) return payload;
    
    let normalizedBudget = normalizeThinkingBudget(modelName, budget);
    
    // Ensure thinking budget < max_tokens. Cap at 75% of max to leave room for actual output,
    // but never below DEFAULT_THINKING_MIN — otherwise the min-budget check at line 235 removes
    // thinkingConfig entirely, silently disabling extended thinking.
    const maxTokens = payload?.request?.generationConfig?.maxOutputTokens || payload?.request?.generationConfig?.max_output_tokens;
    if (maxTokens && maxTokens > 0 && normalizedBudget >= maxTokens) {
        const safeMax = Math.floor(maxTokens * 0.75);
        normalizedBudget = Math.max(DEFAULT_THINKING_MIN, Math.min(normalizedBudget, safeMax));
    }
    
    // 如果是 Claude 模型，检查最小 budget
    if (isClaudeModel) {
        const minBudget = DEFAULT_THINKING_MIN;
        if (normalizedBudget >= 0 && normalizedBudget < minBudget && normalizedBudget !== -1) {
            // Budget 低于最小值，移除 thinking 配置
            delete payload.request.generationConfig.thinkingConfig;
            return payload;
        }
    }
    
    payload.request.generationConfig.thinkingConfig.thinkingBudget = normalizedBudget;
    return payload;
}

/**
 * 将 Gemini 格式请求转换为 Antigravity 格式
 * @param {string} modelName - 模型名称
 * @param {Object} payload - 请求体
 * @param {string} projectId - 项目ID
 * @returns {Object} 转换后的请求体
 */
function geminiToAntigravity(modelName, payload, projectId) {
    // 深拷贝请求体,避免修改原始对象
    // structuredClone (Node 17+) is ~2-3x faster than JSON parse/stringify
    // and preserves typed arrays / dates correctly.
    let template = structuredClone(payload);

    const isClaudeModel = isClaude(modelName);
    const isImgModel = isImageModel(modelName);

    // 设置基本字段
    template.model = modelName;
    template.userAgent = 'antigravity';
    
    // 设置请求类型
    template.requestType = isImgModel ? 'image_gen' : 'agent';
    
    if (projectId) {
        template.project = projectId;
    } else {
        delete template.project;
    }

    // 设置请求ID和会话ID
    if (isImgModel) {
        template.requestId = generateImageGenRequestID();
    } else {
        template.requestId = generateRequestID();
        // 确保 request 对象存在
        if (!template.request) {
            template.request = {};
        }
        // 设置会话ID - 使用稳定的会话ID
        template.request.sessionId = generateStableSessionID(template);
    }

    if (!template.request) {
        template.request = {};
    }

    // 删除安全设置
    if (template.request.safetySettings) {
        delete template.request.safetySettings;
    }

    // For Claude models, ensure tool calling config is set to AUTO whenever tools are
    // present. Without an explicit toolConfig the model acknowledges tool calls in text
    // instead of returning a functionCall part.
    // 'VALIDATED' is not a valid Gemini API value — it caused the model to acknowledge
    // tasks but never execute tool calls, producing silent empty turns.
    if (isClaudeModel && template.request.tools?.length) {
        if (!template.request.toolConfig) {
            template.request.toolConfig = {};
        }
        if (!template.request.toolConfig.functionCallingConfig) {
            template.request.toolConfig.functionCallingConfig = {};
        }
        template.request.toolConfig.functionCallingConfig.mode = 'AUTO';
    }

    // 以前这里会针对 Claude 模型删除 tools，现在为了支持工具调用已移除该限制

    // Antigravity's Gemini endpoint does not accept maxOutputTokens in generationConfig for
    // non-Claude models — sending it causes the model to return empty content. Claude models
    // must keep it (they use a different API path). Per-model defaults are injected earlier
    // in the converter layer (OpenAIConverter.buildGeminiGenerationConfig).
    if (!isClaudeModel) {
        if (template.request.generationConfig && template.request.generationConfig.maxOutputTokens) {
            delete template.request.generationConfig.maxOutputTokens;
        }
        // Remove an empty generationConfig entirely — some models reject {} as invalid argument.
        if (template.request.generationConfig &&
            Object.keys(template.request.generationConfig).length === 0) {
            delete template.request.generationConfig;
        }
    }

    // 处理 Thinking 配置
    // 对于非 gemini-3-* 模型，将 thinkingLevel 转换为 thinkingBudget
    if (!modelName.startsWith('gemini-3-')) {
        if (template.request.generationConfig &&
            template.request.generationConfig.thinkingConfig &&
            template.request.generationConfig.thinkingConfig.thinkingLevel) {
            delete template.request.generationConfig.thinkingConfig.thinkingLevel;
            template.request.generationConfig.thinkingConfig.thinkingBudget = -1;
        }
    }

    // gemini-3.1-pro-low requires explicit thinkingConfig with LOW level.
    // gemini-3.1-pro-high is handled by its model name alone (no explicit thinkingConfig needed);
    // the -high suffix tells the staging API to use the full reasoning budget.
    if (modelName === 'gemini-3.1-pro-low') {
        template.request.generationConfig = template.request.generationConfig || {};
        template.request.generationConfig.thinkingConfig = template.request.generationConfig.thinkingConfig || {};
        const tc = template.request.generationConfig.thinkingConfig;
        if (tc.thinkingLevel === undefined || tc.thinkingLevel === null || tc.thinkingLevel === '') {
            tc.thinkingLevel = 'LOW';
        }
        if (tc.includeThoughts === undefined) tc.includeThoughts = true;
    }

    // 清理所有工具声明中的 JSON Schema 属性（移除 Google API 不支持的属性如 exclusiveMinimum 等）
    if (template.request.tools && Array.isArray(template.request.tools)) {
        template.request.tools.forEach((tool) => {
            if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
                tool.functionDeclarations.forEach((funcDecl) => {
                    if (funcDecl.parametersJsonSchema) {
                        funcDecl.parameters = cleanJsonSchemaProperties(funcDecl.parametersJsonSchema);
                        delete funcDecl.parameters?.$schema;
                        delete funcDecl.parametersJsonSchema;
                    } else if (funcDecl.parameters) {
                        funcDecl.parameters = cleanJsonSchemaProperties(funcDecl.parameters);
                    }
                });
            }
        });
    }

    if (template.request.generationConfig?.responseJsonSchema) {
        template.request.generationConfig.responseJsonSchema = cleanJsonSchemaProperties(template.request.generationConfig.responseJsonSchema);
    }
    if (template.request.generationConfig?.responseSchema) {
        template.request.generationConfig.responseSchema = cleanJsonSchemaProperties(template.request.generationConfig.responseSchema);
    }

    // 处理 Thinking 配置
    // 对于不支持 thinkingLevel 的模型，将 thinkingLevel 转换为 thinkingBudget
    if (!antigravityModelUsesThinkingLevels(modelName)) {
        if (template.request.generationConfig &&
            template.request.generationConfig.thinkingConfig &&
            template.request.generationConfig.thinkingConfig.thinkingLevel) {
            delete template.request.generationConfig.thinkingConfig.thinkingLevel;
            template.request.generationConfig.thinkingConfig.thinkingBudget = -1;
        }
    }

    // 如果是图像模型，增加参数 "generationConfig.imageConfig.imageSize": "4K"
    if (isImgModel) {
        if (!template.request.generationConfig) {
            template.request.generationConfig = {};
        }

        if (!template.request.generationConfig.imageConfig) {
            template.request.generationConfig.imageConfig = {};
        }
        template.request.generationConfig.imageConfig.imageSize = '4K';
        if (!template.request.generationConfig.thinkingConfig) {
            template.request.generationConfig.thinkingConfig = {};
        }
        template.request.generationConfig.thinkingConfig.includeThoughts = false;
    }

    // 规范化 Thinking 配置
    template = normalizeAntigravityThinking(modelName, template, isClaudeModel);

    return template;
}

/**
 * 过滤 SSE 中的 usageMetadata（仅在最终块中保留）
 * @param {string} line - SSE 行数据
 * @returns {string} 过滤后的行数据
 */
function filterSSEUsageMetadata(line) {
    if (!line || typeof line !== 'string') return line;
    
    // 检查是否是 data: 开头的 SSE 数据
    if (!line.startsWith('data: ')) return line;
    
    try {
        const jsonStr = line.slice(6); // 移除 'data: ' 前缀
        const data = JSON.parse(jsonStr);
        
        // 检查是否有 finishReason，如果没有则移除 usageMetadata
        const hasFinishReason = data?.response?.candidates?.[0]?.finishReason ||
                               data?.candidates?.[0]?.finishReason;
        
        if (!hasFinishReason) {
            // 移除 usageMetadata
            if (data.response) {
                delete data.response.usageMetadata;
            }
            if (data.usageMetadata) {
                delete data.usageMetadata;
            }
            return 'data: ' + JSON.stringify(data);
        }
    } catch (e) {
        // 解析失败，返回原始数据
    }
    
    return line;
}

/**
 * 将流式响应转换为非流式响应
 * 用于 Claude 模型的非流式请求（实际上是流式请求然后合并）
 * @param {Buffer|string} stream - 流式响应数据
 * @returns {Object} 合并后的非流式响应
 */
function convertStreamToNonStream(stream) {
    const lines = stream.toString().split('\n');
    
    let responseTemplate = '';
    let traceId = '';
    let finishReason = '';
    let modelVersion = '';
    let responseId = '';
    let role = '';
    let usageRaw = null;
    const parts = [];
    
    // 用于合并连续的 text 和 thought 部分
    let pendingKind = '';
    let pendingText = '';
    let pendingThoughtSig = '';
    
    const flushPending = () => {
        if (!pendingKind) return;
        
        const text = pendingText;
        if (pendingKind === 'text') {
            // Use length check, not trim() — trim silently drops '\n'-only streaming chunks
            // from Claude models where content arrives as whitespace between substantive parts.
            if (text.length > 0) {
                parts.push({ text: text });
            }
        } else if (pendingKind === 'thought') {
            if (text.trim() || pendingThoughtSig) {
                const part = { thought: true, text: text };
                if (pendingThoughtSig) {
                    part.thoughtSignature = pendingThoughtSig;
                }
                parts.push(part);
            }
        }
        
        pendingKind = '';
        pendingText = '';
        pendingThoughtSig = '';
    };
    
    const normalizePart = (part) => {
        const m = { ...part };
        // 处理 thoughtSignature / thought_signature
        const sig = part.thoughtSignature || part.thought_signature;
        if (sig) {
            m.thoughtSignature = sig;
            delete m.thought_signature;
        }
        // 处理 inline_data -> inlineData
        if (m.inline_data) {
            m.inlineData = m.inline_data;
            delete m.inline_data;
        }
        return m;
    };
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        let data;
        try {
            data = JSON.parse(trimmed);
        } catch (e) {
            continue;
        }
        
        let responseNode = data.response;
        if (!responseNode) {
            if (data.candidates) {
                responseNode = data;
            } else {
                continue;
            }
        }
        responseTemplate = JSON.stringify(responseNode);
        
        if (data.traceId) {
            traceId = data.traceId;
        }
        
        if (responseNode.candidates?.[0]?.content?.role) {
            role = responseNode.candidates[0].content.role;
        }
        
        if (responseNode.candidates?.[0]?.finishReason) {
            finishReason = responseNode.candidates[0].finishReason;
        }
        
        if (responseNode.modelVersion) {
            modelVersion = responseNode.modelVersion;
        }
        
        if (responseNode.responseId) {
            responseId = responseNode.responseId;
        }
        
        if (responseNode.usageMetadata) {
            usageRaw = responseNode.usageMetadata;
        } else if (data.usageMetadata) {
            usageRaw = data.usageMetadata;
        }
        
        const partsArray = responseNode.candidates?.[0]?.content?.parts;
        if (Array.isArray(partsArray)) {
            for (const part of partsArray) {
                const hasFunctionCall = part.functionCall !== undefined;
                const hasInlineData = part.inlineData !== undefined || part.inline_data !== undefined;
                const sig = part.thoughtSignature || part.thought_signature || '';
                const text = part.text || '';
                const thought = part.thought || false;
                
                if (hasFunctionCall || hasInlineData) {
                    flushPending();
                    parts.push(normalizePart(part));
                    continue;
                }
                
                if (thought || part.text !== undefined) {
                    const kind = thought ? 'thought' : 'text';
                    if (pendingKind && pendingKind !== kind) {
                        flushPending();
                    }
                    pendingKind = kind;
                    pendingText += text;
                    if (kind === 'thought' && sig) {
                        pendingThoughtSig = sig;
                    }
                    continue;
                }
                
                flushPending();
                parts.push(normalizePart(part));
            }
        }
    }
    
    flushPending();
    
    // 构建最终响应
    if (!responseTemplate) {
        responseTemplate = '{"candidates":[{"content":{"role":"model","parts":[]}}]}';
    }
    
    let result = JSON.parse(responseTemplate);
    
    // 设置 parts
    if (!result.candidates) {
        result.candidates = [{ content: { role: 'model', parts: [] } }];
    }
    if (!result.candidates[0]) {
        result.candidates[0] = { content: { role: 'model', parts: [] } };
    }
    if (!result.candidates[0].content) {
        result.candidates[0].content = { role: 'model', parts: [] };
    }
    result.candidates[0].content.parts = parts;
    
    if (role) {
        result.candidates[0].content.role = role;
    }
    if (finishReason) {
        result.candidates[0].finishReason = finishReason;
    }
    if (modelVersion) {
        result.modelVersion = modelVersion;
    }
    if (responseId) {
        result.responseId = responseId;
    }
    if (usageRaw) {
        result.usageMetadata = usageRaw;
    } else if (!result.usageMetadata) {
        result.usageMetadata = {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0
        };
    }
    
    // 包装为最终格式
    const output = {
        response: result,
        traceId: traceId || ''
    };
    
    return output;
}

/**
 * 将 Antigravity 响应转换为 Gemini 格式
 * @param {Object} antigravityResponse - Antigravity 响应
 * @returns {Object|null} Gemini 格式响应
 */
function toGeminiApiResponse(antigravityResponse) {
    if (!antigravityResponse) return null;

    const compliantResponse = {
        candidates: antigravityResponse.candidates
    };

    if (antigravityResponse.usageMetadata) {
        compliantResponse.usageMetadata = antigravityResponse.usageMetadata;
    }

    if (antigravityResponse.promptFeedback) {
        compliantResponse.promptFeedback = antigravityResponse.promptFeedback;
    }

    if (antigravityResponse.automaticFunctionCallingHistory) {
        compliantResponse.automaticFunctionCallingHistory = antigravityResponse.automaticFunctionCallingHistory;
    }

    return compliantResponse;
}

/**
 * 确保请求体中的内容部分都有角色属性，并修复历史记录中的思考签名
 * @param {Object} requestBody - 请求体
 * @returns {Object} 处理后的请求体
 */
function ensureRolesInContents(requestBody, modelName) {
    delete requestBody.model;
    // delete requestBody.system_instruction;
    // delete requestBody.systemInstruction;
    if (requestBody.system_instruction) {
        requestBody.systemInstruction = requestBody.system_instruction;
        delete requestBody.system_instruction;
    }

    // 提取现有的系统提示词
    let originalSystemPrompt = requestBody.systemInstruction;
    
    // 如果 systemInstruction 是对象格式，提取其中的文本内容
    let originalSystemPromptText = '';
    if (originalSystemPrompt) {
        if (typeof originalSystemPrompt === 'string') {
            originalSystemPromptText = originalSystemPrompt;
        } else if (typeof originalSystemPrompt === 'object') {
            // 处理对象格式的 systemInstruction
            if (originalSystemPrompt.parts && Array.isArray(originalSystemPrompt.parts)) {
                // 从 parts 数组中提取所有文本
                originalSystemPromptText = originalSystemPrompt.parts
                    .map(part => {
                        if (typeof part === 'string') return part;
                        if (part && typeof part.text === 'string') return part.text;
                        return '';
                    })
                    .filter(text => text)
                    .join('\n');
            } else if (originalSystemPrompt.text) {
                // 直接有 text 属性
                originalSystemPromptText = originalSystemPrompt.text;
            }
        }
    }
    
    const name = modelName ? modelName.toLowerCase() : '';
    const useAntigravityPrompt = name.includes('gemini-3-pro');
    const isClaudeModel = name.includes('claude');

    if (useAntigravityPrompt) {
        // For Gemini models: use Antigravity system prompt
        const parts = [
            { text: ANTIGRAVITY_SYSTEM_PROMPT }
        ];

        if (originalSystemPromptText) {
            parts.push({ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_PROMPT}[/ignore]` });
            parts.push({ text: originalSystemPromptText });
        }

        requestBody.systemInstruction = {
            role: 'user',
            parts: parts
        };
    } else if (isClaudeModel && originalSystemPromptText) {
        // For Claude models: skip Antigravity prompt, use only original system prompt
        requestBody.systemInstruction = {
            role: 'user',
            parts: [{ text: originalSystemPromptText }]
        };
    } else if (originalSystemPromptText) {
        // For other models: use original system prompt if present
        requestBody.systemInstruction = {
            role: 'user',
            parts: [{ text: originalSystemPromptText }]
        };
    } else {
        // No valid system prompt, remove the field
        delete requestBody.systemInstruction;
    }

    if (requestBody.contents && Array.isArray(requestBody.contents)) {
        requestBody.contents.forEach(content => {
            if (!content.role) {
                content.role = 'user';
            }
            if (useAntigravity) {
                normalizeAntigravityTextParts(content.parts);
            }
        });
    }

    return requestBody;
}

// Claude model names inside Antigravity payloads are bare ('claude-sonnet-4-6') but the
// pool manager tracks them under their routing key ('gemini-claude-sonnet-4-6').
// Use this helper so cooldowns set by the adapter always match what selectProvider checks.
function toPoolModelKey(modelId) {
    return (modelId && modelId.startsWith('claude-')) ? `gemini-${modelId}` : modelId;
}

export class AntigravityApiService {
    constructor(config) {
        // 配置 HTTP/HTTPS agent 限制连接池大小，避免资源泄漏
        this.httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });

        this.availableModels = [];
        this.isInitialized = false;

        this.config = config;
        this.host = config.HOST;
        this.oauthCredsFilePath = config.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;
        this.userAgent = DEFAULT_USER_AGENT; // 支持通用 USER_AGENT 配置
        this.projectId = config.PROJECT_ID;
        this.uuid = config.uuid; // 保存 uuid 用于缓存管理

        // 多环境降级顺序
        this.baseURLs = this.getBaseURLFallbackOrder(config);

        // 保存代理配置供后续使用
        this.proxyConfig = getProxyConfigForProvider(config, config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY);

        // 检查是否需要使用代理
        const proxyConfig = getGoogleAuthProxyConfig(config, config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY);

        // 检查是否启用了 TLS Sidecar
        const isTLSSidecarEnabled = isTLSSidecarEnabledForProvider(config, config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY);

        // 配置 OAuth2Client 使用自定义的 HTTP agent
        const oauth2Options = {
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
        };

        if (isTLSSidecarEnabled) {
            logger.info('[Antigravity] TLS Sidecar enabled, skipping proxy/agent configuration for OAuth2Client');
        } else if (proxyConfig) {
            oauth2Options.transporterOptions = proxyConfig;
            logger.info('[Antigravity] Using proxy for OAuth2Client');
        } else {
            // 根据 base URL 判断使用 http 还是 https agent
            const firstBaseURL = this.baseURLs && this.baseURLs.length > 0 ? this.baseURLs[0] : '';
            const useHttp = firstBaseURL.startsWith('http://');
            oauth2Options.transporterOptions = {
                agent: useHttp ? this.httpAgent : this.httpsAgent,
            };
            if (useHttp) {
                logger.info('[Antigravity] Using HTTP agent for OAuth2Client');
            }
        }

        this.authClient = new OAuth2Client(oauth2Options);
    }

    _applySidecar(requestOptions) {
        return configureTLSSidecar(requestOptions, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY);
    }

    /**
     * 获取 Base URL 降级顺序
     * @param {Object} config - 配置对象
     * @returns {string[]} Base URL 列表
     */
    getBaseURLFallbackOrder(config) {
        // 如果配置了自定义 base_url，只使用该 URL
        if (config.ANTIGRAVITY_BASE_URL) {
            return [config.ANTIGRAVITY_BASE_URL.replace(/\/$/, '')];
        }
        
        // 默认降级顺序与 Antigravity 官方调用链保持一致：daily -> prod
        return [
            ANTIGRAVITY_BASE_URL_DAILY,
            ANTIGRAVITY_BASE_URL_PROD
        ];
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Antigravity] Initializing Antigravity API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();

        if (!this.projectId) {
            this.projectId = await this.discoverProjectAndModels();
        } else {
            logger.info(`[Antigravity] Using provided Project ID: ${this.projectId}`);
            // 获取可用模型
            await this.fetchAvailableModels();
        }

        this.isInitialized = true;
        logger.info(`[Antigravity] Initialization complete. Project ID: ${this.projectId}`);
    }

    /**
     * 加载凭证信息（不执行刷新）
     */
    async loadCredentials() {
        const credPath = this.oauthCredsFilePath || path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
        try {
            const data = await fs.readFile(credPath, "utf8");
            const credentials = JSON.parse(data);
            this.authClient.setCredentials(credentials);
            logger.info('[Antigravity Auth] Credentials loaded successfully from file.');
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.debug(`[Antigravity Auth] Credentials file not found: ${credPath}`);
            } else {
                logger.warn(`[Antigravity Auth] Failed to load credentials from file: ${error.message}`);
            }
        }
    }

    async initializeAuth(forceRefresh = false) {
        const credPath = this.oauthCredsFilePath || path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
        
        // 首先执行基础凭证加载
        await this.loadCredentials();

        // 检查是否需要刷新 Token（在加载凭证后重新评估）
        const needsRefresh = forceRefresh || this.isTokenExpiringSoon();

        if (this.authClient.credentials.access_token && !needsRefresh) {
            // Token 有效且不需要刷新
            return;
        }

        // 只有在明确要求刷新，或者 AccessToken 确实缺失时，才执行刷新/认证
        // 注意：在 V2 架构下，此方法主要由 PoolManager 的后台队列调用
        if (needsRefresh || !this.authClient.credentials.access_token) {
            try {
                if (this.authClient.credentials.refresh_token) {
                    logger.info('[Antigravity Auth] Token expiring soon or force refresh requested. Refreshing token...');
                    const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                    this.authClient.setCredentials(newCredentials);
                    await this._saveCredentialsToFile(credPath, newCredentials);
                    logger.info(`[Antigravity Auth] Token refreshed and saved to ${credPath} successfully.`);

                    // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
                    const poolManager = getProviderPoolManager();
                    if (poolManager && this.uuid) {
                        poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, this.uuid);
                    }
                } else {
                    logger.info(`[Antigravity Auth] No access token or refresh token. Starting new authentication flow...`);
                    const newTokens = await this.getNewToken(credPath);
                    this.authClient.setCredentials(newTokens);
                    logger.info('[Antigravity Auth] New token obtained and loaded into memory.');
                    
                    // 认证成功，重置状态
                    const poolManager = getProviderPoolManager();
                    if (poolManager && this.uuid) {
                        poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, this.uuid);
                    }
                }
            } catch (error) {
                logger.error('[Antigravity Auth] Failed to initialize authentication:', error);
                throw new Error(`Failed to load OAuth credentials.`);
            }
        }
    }

    async getNewToken(credPath) {
        // 使用统一的 OAuth 处理方法
        const { authUrl } = await handleGeminiAntigravityOAuth(this.config);
        
        logger.info('\n[Antigravity Auth] 正在自动打开浏览器进行授权...');
        logger.info('[Antigravity Auth] 授权链接:', authUrl, '\n');

        // 自动打开浏览器
        const showFallbackMessage = () => {
            logger.info('[Antigravity Auth] 无法自动打开浏览器，请手动复制上面的链接到浏览器中打开');
        };

        const disableAutoOpen = process.env.DISABLE_AUTO_OPEN_BROWSER === 'true' || 
            (this.config && this.config.DISABLE_AUTO_OPEN_BROWSER) || 
            !process.stdout.isTTY;

        if (this.config && !disableAutoOpen) {
            try {
                const childProcess = await open(authUrl);
                if (childProcess) {
                    childProcess.on('error', () => showFallbackMessage());
                }
            } catch (_err) {
                showFallbackMessage();
            }
        } else {
            showFallbackMessage();
        }

        // 等待 OAuth 回调完成并读取保存的凭据
        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                try {
                    const data = await fs.readFile(credPath, 'utf8');
                    const credentials = JSON.parse(data);
                    if (credentials.access_token) {
                        clearInterval(checkInterval);
                        logger.info('[Antigravity Auth] New token obtained successfully.');
                        resolve(credentials);
                    }
                } catch (error) {
                    // 文件尚未创建或无效，继续等待
                }
            }, 1000);

            // 设置超时（5分钟）
            setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('[Antigravity Auth] OAuth 授权超时'));
            }, 5 * 60 * 1000);
        });
    }

    isTokenExpiringSoon() {
        if (!this.authClient.credentials.expiry_date) {
            return false;
        }
        const currentTime = Date.now();
        const expiryTime = this.authClient.credentials.expiry_date;
        const refreshSkewMs = REFRESH_SKEW * 1000;
        return expiryTime <= (currentTime + refreshSkewMs);
    }

    /**
     * 保存凭证到文件
     * @param {string} filePath - 凭证文件路径
     * @param {Object} credentials - 凭证数据
     */
    async _saveCredentialsToFile(filePath, credentials) {
        try {
            await atomicWriteFile(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
            logger.info(`[Antigravity Auth] Credentials saved to ${filePath}`);
        } catch (error) {
            logger.error(`[Antigravity Auth] Failed to save credentials to ${filePath}: ${error.message}`);
            throw error;
        }
    }

    async discoverProjectAndModels() {
        if (this.projectId) {
            logger.info(`[Antigravity] Using pre-configured Project ID: ${this.projectId}`);
            return this.projectId;
        }

        logger.info('[Antigravity] Discovering Project ID...');
        try {
            const initialProjectId = "";
            // Prepare client metadata
            const clientMetadata = {
                ideType: "ANTIGRAVITY"
            };

            // Call loadCodeAssist to discover the actual project ID
            const loadRequest = {
                metadata: clientMetadata
            };

            // 并行执行：API 调用和 Token 信息获取（如果需要）
            const tokenPromise = this.authClient.credentials?.access_token 
                ? this.authClient.getTokenInfo(this.authClient.credentials.access_token).catch(() => null)
                : Promise.resolve(null);
                
            const [loadResponse, tokenInfo] = await Promise.all([
                this.callApi('loadCodeAssist', loadRequest),
                tokenPromise
            ]);

            // 提取账号邮箱
            if (loadResponse.manageSubscriptionUri) {
                const uri = loadResponse.manageSubscriptionUri;
                const emailMatch = uri.match(/Email=([^&]+)/);
                if (emailMatch) {
                    this.accountEmail = decodeURIComponent(emailMatch[1]);
                }
            }

            if (!this.accountEmail && tokenInfo?.email) {
                this.accountEmail = tokenInfo.email;
            }

            if (this.accountEmail) {
                logger.info(`[Antigravity] Extracted account email: ${this.accountEmail}`);
            }

            // Check if we already have a project ID from the response
            if (loadResponse.cloudaicompanionProject) {
                logger.info(`[Antigravity] Discovered existing Project ID: ${loadResponse.cloudaicompanionProject}`);
                this.projectId = loadResponse.cloudaicompanionProject;
                // 尝试从 allowedTiers 中获取当前 tierId，如果存在 paidTier 则优先使用 paidTier.id
                const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
                const baseTier = defaultTier?.id || 'free-tier';
                this.tierId = loadResponse.paidTier?.name ? `${loadResponse.paidTier.name}(${baseTier.replace('-tier', '')})` : baseTier;
                // 获取可用模型
                // await this.fetchAvailableModels(); // PRUNED: Skip for faster bootstrap, use static list
                this.availableModels = ANTIGRAVITY_MODELS;
                return loadResponse.cloudaicompanionProject;
            }

            // If no existing project, we need to onboard
            const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
            const baseTier = defaultTier?.id || 'free-tier';
            const tierId = loadResponse.paidTier?.name ? `${loadResponse.paidTier.name}(${baseTier.replace('-tier', '')})` : baseTier;
            this.tierId = tierId;

            const onboardRequest = {
                tier_id: baseTier,
                metadata: {
                    ide_type: 'ANTIGRAVITY',
                    ide_version: this.userAgent.match(/antigravity\/([^ ]+)/)?.[1] || '',
                    ide_name: 'antigravity'
                },
            };

            let lroResponse = await this.callApi('onboardUser', onboardRequest);

            // Poll until operation is complete with timeout protection
            const MAX_RETRIES = 60; // Increased retries but reduced delay
            let retryCount = 0;

            while (!lroResponse.done && retryCount < MAX_RETRIES) {
                // Reduced polling interval from 2000ms to 500ms for faster bootstrap
                await new Promise(resolve => setTimeout(resolve, 500));
                lroResponse = await this.callApi('onboardUser', onboardRequest);
                retryCount++;
            }

            if (!lroResponse.done) {
                throw new Error('Onboarding timeout: Operation did not complete within expected time.');
            }

            const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId;
            logger.info(`[Antigravity] Onboarded and discovered Project ID: ${discoveredProjectId}`);
            this.projectId = discoveredProjectId;
            // 获取可用模型
            await this.fetchAvailableModels();
            return discoveredProjectId;
        } catch (error) {
            logger.error('[Antigravity] Failed to discover Project ID:', error.response?.data || error.message);
            logger.info('[Antigravity] Falling back to generated Project ID as last resort...');
            const fallbackProjectId = generateProjectID();
            logger.info(`[Antigravity] Generated fallback Project ID: ${fallbackProjectId}`);
            this.projectId = fallbackProjectId;
            // 获取可用模型
            await this.fetchAvailableModels();
            return fallbackProjectId;
        }
    }

    async fetchAvailableModels() {
        logger.info('[Antigravity] Fetching available models...');

        for (const baseURL of this.baseURLs) {
            try {
                const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
                const requestOptions = {
                    url: modelsURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent
                    },
                    responseType: 'json',
                    body: JSON.stringify(this.projectId ? { project: this.projectId } : {})
                };

                const res = await this.authClient.request(requestOptions);
                // logger.info(`[Antigravity] Raw response from ${baseURL}:`, Object.keys(res.data.models));
                if (res.data && res.data.models) {
                    const models = Object.keys(res.data.models);
                    const seenModels = new Set();
                    this.availableModels = models
                        .flatMap(modelId => expandAntigravityClientModels(modelId))
                        .filter(modelId => {
                            if (!modelId || seenModels.has(modelId)) return false;
                            seenModels.add(modelId);
                            return true;
                        });

                    logger.info(`[Antigravity] Available models: [${this.availableModels.join(', ')}]`);
                    return;
                }
            } catch (error) {
                logger.error(`[Antigravity] Failed to fetch models from ${baseURL}:`, error.message);
            }
        }

        logger.warn('[Antigravity] Failed to fetch models from all endpoints. Using default models.');
        this.availableModels = ANTIGRAVITY_MODELS;
    }

    async listModels() {
        if (!this.isInitialized) await this.initialize();

        const now = Math.floor(Date.now() / 1000);
        const formattedModels = this.availableModels.map(modelId => {
            const displayName = modelId.split('-').map(word =>
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' ');
            const metadata = getAntigravityModelMetadata(modelId);

            const modelInfo = {
                name: `models/${modelId}`,
                version: '1.0.0',
                displayName: displayName,
                description: `Antigravity model: ${modelId}`,
                inputTokenLimit: 1024000,
                outputTokenLimit: metadata?.maxOutputTokens || 65535,
                supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
                object: 'model',
                created: now,
                ownedBy: 'antigravity',
                type: 'antigravity'
            };

            if (metadata?.thinking) {
                modelInfo.thinking = {
                    min: metadata.thinking.min,
                    max: metadata.thinking.max,
                    zeroAllowed: metadata.thinking.zeroAllowed || false,
                    dynamicAllowed: metadata.thinking.dynamicAllowed || false
                };
                if (metadata.thinking.levels) {
                    modelInfo.thinking.levels = metadata.thinking.levels;
                }
            }

            return modelInfo;
        });

        return { models: formattedModels };
    }

    async callApi(method, body, isRetry = false, retryCount = 0, baseURLIndex = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        if (baseURLIndex >= this.baseURLs.length) {
            throw new Error('All Antigravity base URLs failed');
        }

        const baseURL = this.baseURLs[baseURLIndex];

        try {
            const requestOptions = {
                url: `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': this.userAgent
                },
                responseType: 'json',
                body: JSON.stringify(body)
            };

            this._applySidecar(requestOptions);
            const res = await this.authClient.request(requestOptions);
            return res.data;
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            logger.error(`[Antigravity API] Error calling (Status: ${status}, Code: ${errorCode}):`, error.message);

            if (status === 400) {
                logger.info(`[Antigravity API] Received 400 Bad Request. Triggering credential switch to try another account...`);
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            if ((status === 401 || status === 403) && !isRetry) {
                const is403 = status === 403;
                const reason = is403 ? '403 Permission Denied' : '401 Unauthorized';
                logger.info(`[Antigravity API] Received ${status}. Triggering credential switch via PoolManager...`);

                // Distinguish account-fatal 403 (bootstrap or GCP-project broken) from
                // model-specific 403 (transient or model-tier denial). Bootstrap methods
                // (loadCodeAssist/onboardUser) failing 403 means the account's GCP project
                // does not have the Gemini-for-Cloud API enabled — account-dark is correct.
                // For generateContent/streamGenerateContent 403s without that fatal signature,
                // apply per-account model cooldown so OTHER accounts can serve this model.
                //
                // Special case: "Gemini for Google Cloud API (Staging) has not been used in
                // project X" on a generateContent call means only the staging endpoint is
                // missing — the account can still serve non-staging models (gemini-3-flash etc).
                // Use a 24h model cooldown rather than marking the entire account dark.
                const isBootstrapMethod = method === 'loadCodeAssist' || method === 'onboardUser';
                const errMsgLower = (error.message || '').toLowerCase();
                const isStagingApiMissing = errMsgLower.includes('has not been used in project')
                    && errMsgLower.includes('staging');
                const isAccountFatal = isBootstrapMethod
                    || (!isBootstrapMethod && !isStagingApiMissing && (
                        errMsgLower.includes('has not been used in project')
                        || errMsgLower.includes('api is not enabled')
                        || errMsgLower.includes('api has not been used')
                    ));

                const poolManager = getProviderPoolManager();
                const ptype = this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY;
                const modelId = toPoolModelKey(body?.model || body?.request?.model);
                // Claude-tier 403: cool only THIS account for this model so the other accounts
                // in the pool remain available. All-accounts cooldown was preventing accounts
                // with remaining quota from being selected after one account was exhausted.
                const isClaudeTier = typeof modelId === 'string' && modelId.startsWith('gemini-claude-');
                if (poolManager && is403 && !isAccountFatal && isClaudeTier && !isStagingApiMissing && modelId && this.uuid) {
                    const cooldownMs = 120000; // 2 min — Vertex passthrough denial is per-account, not global
                    logger.warn(`[Antigravity] Claude-tier 403 for ${modelId} on account ${this.uuid} — cooling THIS account only (${cooldownMs}ms), others remain available.`);
                    if (typeof poolManager.markModelCooldownForAccount === 'function') {
                        poolManager.markModelCooldownForAccount(ptype, this.uuid, modelId, cooldownMs);
                    }
                    error.credentialMarkedUnhealthy = true;
                } else if (poolManager && this.uuid) {
                    if (is403 && isAccountFatal) {
                        // True account-level failure — mark account dark.
                        logger.info(`[Antigravity] Marking credential ${this.uuid} immediately unhealthy (account-fatal 403). Reason: ${reason}`);
                        poolManager.markProviderUnhealthyImmediately(ptype, {
                            uuid: this.uuid
                        }, reason);
                        error.credentialMarkedUnhealthy = true;
                    } else if (is403) {
                        // Model-specific 403 — cool down only THIS model on THIS account.
                        // Staging-API-missing is a known Google false-positive on verified-active accounts;
                        // use the same short cooldown so the account re-enters the pool after rotation.
                        const cooldownMs = 60000;
                        if (modelId && typeof poolManager.markModelCooldownForAccount === 'function') {
                            logger.info(`[Antigravity] Per-account cooldown for ${this.uuid} on model ${modelId} (403, not account-fatal, ${cooldownMs}ms)`);
                            poolManager.markModelCooldownForAccount(ptype, this.uuid, modelId, cooldownMs);
                            error.credentialMarkedUnhealthy = true;
                        } else {
                            // No model id resolvable — fall back to needs-refresh (less destructive than immediate-unhealthy).
                            logger.info(`[Antigravity] Marking credential ${this.uuid} as needs refresh (403, model unknown)`);
                            poolManager.markProviderNeedRefresh(ptype, { uuid: this.uuid });
                            error.credentialMarkedUnhealthy = true;
                        }
                    } else {
                        // 401 — token may be stale; refresh is the right action.
                        logger.info(`[Antigravity] Marking credential ${this.uuid} as needs refresh. Reason: ${reason}`);
                        poolManager.markProviderNeedRefresh(ptype, {
                            uuid: this.uuid
                        });
                        error.credentialMarkedUnhealthy = true;
                    }
                }

                // For staging-API-missing (known Google false-positive on verified-active accounts):
                // try the next base URL before switching accounts — the non-sandbox URL
                // (daily-cloudcode-pa.googleapis.com) does not require the staging API.
                if (isStagingApiMissing && !isBootstrapMethod && baseURLIndex + 1 < this.baseURLs.length) {
                    logger.info(`[Antigravity API] Staging endpoint ${baseURL} returned known false-positive — retrying on next base URL...`);
                    return this.callApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 429 — rotate base URLs first (correct for multi-URL accounts), then throw
            // immediately to trigger pool-manager account rotation. No per-account backoff.
            if (status === 429) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    logger.info(`[Antigravity API] Rate limited on ${baseURL}. Trying next base URL...`);
                    return this.callApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                }
                // Apply per-account model cooldown for 429 to give this account a break
                // without taking the whole account offline.
                const poolManager = getProviderPoolManager();
                const modelId = toPoolModelKey(body?.model || body?.request?.model);
                if (poolManager && this.uuid && modelId && typeof poolManager.markModelCooldownForAccount === 'function') {
                    poolManager.markModelCooldownForAccount(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, this.uuid, modelId, 60000);
                    error.credentialMarkedUnhealthy = true;
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                }
                throw error;
            }

            // Handle network errors - try next base URL first, then retry with backoff
            if (isNetworkError) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                    logger.info(`[Antigravity API] Network error (${errorIdentifier}) on ${baseURL}. Trying next base URL...`);
                    return this.callApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                } else if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                    logger.info(`[Antigravity API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(method, body, isRetry, retryCount + 1, 0);
                }
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Antigravity API] Server error ${status}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1, baseURLIndex);
            }

            throw error;
        }
    }

    async * streamApi(method, body, isRetry = false, retryCount = 0, baseURLIndex = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        if (baseURLIndex >= this.baseURLs.length) {
            throw new Error('All Antigravity base URLs failed');
        }

        const baseURL = this.baseURLs[baseURLIndex];

        try {
            const requestOptions = {
                url: `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`,
                method: 'POST',
                params: { alt: 'sse' },
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'User-Agent': this.userAgent
                },
                responseType: 'stream',
                body: JSON.stringify(body)
            };

            this._applySidecar(requestOptions);
            const res = await this.authClient.request(requestOptions);

            if (res.status !== 200) {
                let errorBody = '';
                for await (const chunk of res.data) {
                    errorBody += chunk.toString();
                }
                const apiError = new Error(`Upstream API Error (Status ${res.status}): ${errorBody}`);
                apiError.response = { status: res.status, data: errorBody };
                apiError.status = res.status;
                throw apiError;
            }

            yield* this.parseSSEStream(res.data);
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            logger.error(`[Antigravity API] Error during stream (Status: ${status}, Code: ${errorCode}):`, error.message);

            if (status === 400) {
                logger.info(`[Antigravity API] Received 400 Bad Request during stream. Triggering credential switch to try another account...`);
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            if ((status === 401 || status === 403) && !isRetry) {
                const is403 = status === 403;
                const reason = is403 ? '403 Permission Denied' : '401 Unauthorized';
                logger.info(`[Antigravity API] Received ${status} during stream. Triggering credential switch via PoolManager...`);

                const isBootstrapMethod = method === 'loadCodeAssist' || method === 'onboardUser';
                const errMsgLower = (error.message || '').toLowerCase();
                const isStagingApiMissing = errMsgLower.includes('has not been used in project')
                    && errMsgLower.includes('staging');
                const isAccountFatal = isBootstrapMethod
                    || (!isBootstrapMethod && !isStagingApiMissing && (
                        errMsgLower.includes('has not been used in project')
                        || errMsgLower.includes('api is not enabled')
                        || errMsgLower.includes('api has not been used')
                    ));

                const poolManager = getProviderPoolManager();
                const ptype = this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY;
                const modelId = toPoolModelKey(body?.model || body?.request?.model);
                // Claude-tier 403: cool only THIS account for this model so the other accounts
                // in the pool remain available. All-accounts cooldown was preventing accounts
                // with remaining quota from being selected after one account was exhausted.
                const isClaudeTier = typeof modelId === 'string' && modelId.startsWith('gemini-claude-');
                if (poolManager && is403 && !isAccountFatal && isClaudeTier && !isStagingApiMissing && modelId && this.uuid) {
                    const cooldownMs = 120000; // 2 min — short enough for 13-account pool to recover quickly
                    logger.warn(`[Antigravity] Claude-tier 403 for ${modelId} on account ${this.uuid} — cooling THIS account only (${cooldownMs}ms), others remain available.`);
                    if (typeof poolManager.markModelCooldownForAccount === 'function') {
                        poolManager.markModelCooldownForAccount(ptype, this.uuid, modelId, cooldownMs);
                    }
                    error.credentialMarkedUnhealthy = true;
                } else if (poolManager && this.uuid) {
                    if (is403 && isAccountFatal) {
                        logger.info(`[Antigravity] Marking credential ${this.uuid} immediately unhealthy (account-fatal 403). Reason: ${reason}`);
                        poolManager.markProviderUnhealthyImmediately(ptype, {
                            uuid: this.uuid
                        }, reason);
                        error.credentialMarkedUnhealthy = true;
                    } else if (is403) {
                        // Staging-API-missing is a known Google false-positive on verified-active accounts;
                        // use the same short cooldown so the account re-enters the pool after rotation.
                        const cooldownMs = 60000;
                        if (modelId && typeof poolManager.markModelCooldownForAccount === 'function') {
                            logger.info(`[Antigravity] Per-account stream cooldown for ${this.uuid} on model ${modelId} (403, not account-fatal, ${cooldownMs}ms)`);
                            poolManager.markModelCooldownForAccount(ptype, this.uuid, modelId, cooldownMs);
                            error.credentialMarkedUnhealthy = true;
                        } else {
                            logger.info(`[Antigravity] Marking credential ${this.uuid} as needs refresh (stream 403, model unknown)`);
                            poolManager.markProviderNeedRefresh(ptype, { uuid: this.uuid });
                            error.credentialMarkedUnhealthy = true;
                        }
                    } else {
                        logger.info(`[Antigravity] Marking credential ${this.uuid} as needs refresh. Reason: ${reason}`);
                        poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, {
                            uuid: this.uuid
                        });
                        error.credentialMarkedUnhealthy = true;
                    }
                }

                // For staging-API-missing (known Google false-positive on verified-active accounts):
                // try the next base URL before switching accounts — the non-sandbox URL
                // (daily-cloudcode-pa.googleapis.com) does not require the staging API.
                if (isStagingApiMissing && !isBootstrapMethod && baseURLIndex + 1 < this.baseURLs.length) {
                    logger.info(`[Antigravity API] Staging endpoint ${baseURL} returned known false-positive during stream — retrying on next base URL...`);
                    yield* this.streamApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                    return;
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 429 — rotate base URLs first, then throw immediately for account rotation.
            if (status === 429) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    logger.info(`[Antigravity API] Rate limited on ${baseURL}. Trying next base URL...`);
                    yield* this.streamApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                    return;
                }
                // Per-account model cooldown for 429 — don't kill the whole account.
                const poolManager = getProviderPoolManager();
                const modelId = toPoolModelKey(body?.model || body?.request?.model);
                if (poolManager && this.uuid && modelId && typeof poolManager.markModelCooldownForAccount === 'function') {
                    poolManager.markModelCooldownForAccount(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, this.uuid, modelId, 60000);
                    error.credentialMarkedUnhealthy = true;
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                }
                throw error;
            }

            // Handle network errors - try next base URL first, then retry with backoff
            if (isNetworkError) {
                if (baseURLIndex + 1 < this.baseURLs.length) {
                    const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                    logger.info(`[Antigravity API] Network error (${errorIdentifier}) on ${baseURL} during stream. Trying next base URL...`);
                    yield* this.streamApi(method, body, isRetry, retryCount, baseURLIndex + 1);
                    return;
                } else if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                    logger.info(`[Antigravity API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(method, body, isRetry, retryCount + 1, 0);
                    return;
                }
            }

            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Antigravity API] Server error ${status} during stream. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(method, body, isRetry, retryCount + 1, baseURLIndex);
                return;
            }

            throw error;
        }
    }

    async * parseSSEStream(stream) {
        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        const sseFields = /^(data|event|id|retry):/i;
        let buffer = [];
        for await (let line of rl) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('data: ')) {
                // 过滤 usageMetadata（仅在最终块中保留）
                const processedLine = filterSSEUsageMetadata(trimmedLine);
                buffer.push(processedLine.slice(6));
            } else if (trimmedLine === '' && buffer.length > 0) {
                try {
                    yield JSON.parse(buffer.join('\n'));
                } catch (e) {
                    logger.error('[Antigravity Stream] Failed to parse JSON chunk:', buffer.join('\n'), 'Error:', e.message);
                }
                buffer = [];
            } else if (trimmedLine && !trimmedLine.startsWith(':') && !sseFields.test(trimmedLine) && buffer.length > 0) {
                // 处理不带 SSE 字段前缀且不是注释的后续行（可能是由于换行符导致的分割）
                buffer.push(trimmedLine);
            }
        }

        if (buffer.length > 0) {
            try {
                yield JSON.parse(buffer.join('\n'));
            } catch (e) {
                logger.error('[Antigravity Stream] Failed to parse final JSON chunk:', buffer.join('\n'), 'Error:', e.message);
            }
        }
    }

    prepareRequestMetadata(requestBody) {
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Antigravity] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, {
                    uuid: this.uuid
                });
            }
        }
    }

        // Resolve user-friendly 3.5-flash aliases to their actual Antigravity API model IDs.
        // "High" and "Medium" are cockpit display names — the real API IDs differ.
        const FLASH_ALIASES_NON_STREAM = {
            'gemini-3.5-flash-high':   'gemini-3-flash-agent',
            'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
        };
        let selectedModel = FLASH_ALIASES_NON_STREAM[model] ?? model;
        if (!this.availableModels.includes(selectedModel)) {
            logger.warn(`[Antigravity] Model '${model}' not found. Using default model: 'gemini-3-flash'`);
            selectedModel = 'gemini-3-flash';
            requestBody.model = selectedModel;
        }

        // 移除 gemini- 前缀以获取实际模型名称（针对 claude 模型）
        const actualModelName = selectedModel.startsWith('gemini-claude-') ? selectedModel.replace('gemini-claude-', 'claude-') : selectedModel;
        logger.info(`[Antigravity] Selected model: ${actualModelName}`);
        // 深拷贝请求体 (structuredClone is faster than JSON parse/stringify)
        const processedRequestBody = ensureRolesInContents(structuredClone(requestBody), actualModelName);
        const isClaudeModel = isClaude(actualModelName);

        applyAntigravityClientModelThinkingLevelToRequest(requestBody, selectedModel);
        const processedRequestBody = ensureRolesInContents(JSON.parse(JSON.stringify(requestBody)), selectedModel);
        const payload = applyAntigravityClientModelThinkingLevel(
            geminiToAntigravity(actualModelName, { request: processedRequestBody }, this.projectId),
            selectedModel
        );

        payload.model = actualModelName;
        // console.error("DEBUG PAYLOAD REQUEST KEYS: ", Object.keys(payload.request));

        return { payload, selectedModel, actualModelName };
    }

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();
        logger.info(`[Antigravity Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        this.prepareRequestMetadata(requestBody);
        const { payload, selectedModel, actualModelName } = this.buildAntigravityPayload(model, requestBody);

        // 对于 Claude / Gemini 3 Pro / 图像模型，使用流式请求然后转换为非流式响应
        if (antigravityModelRequiresStreamForNonStream(actualModelName) || antigravityModelRequiresStreamForNonStream(selectedModel)) {
            return await this.executeClaudeNonStream(payload);
        }

        const response = await this.callApi('generateContent', payload);
        return toGeminiApiResponse(response.response);
    }

    /**
     * 执行 Claude 非流式请求
     * Claude 模型实际上使用流式请求，然后将结果合并为非流式响应
     * @param {Object} payload - 请求体
     * @returns {Object} 非流式响应
     */
    async executeClaudeNonStream(payload) {
        const chunks = [];

        try {
            const stream = this.streamApi('streamGenerateContent', payload);
            for await (const chunk of stream) {
                if (chunk) {
                    chunks.push(JSON.stringify(chunk));
                }
            }

            // Surface provider errors (403/429/5xx return non-SSE bodies that the SSE
            // parser skips entirely, leaving chunks empty) so LiteLLM can retry/fallback
            // instead of receiving a silent 200 with empty content.
            if (chunks.length === 0) {
                throw new Error('[Antigravity] Claude stream returned no chunks — provider returned HTTP error or empty response');
            }

            // 将流式响应转换为非流式响应
            const streamData = chunks.join('\n');
            const nonStreamResponse = convertStreamToNonStream(streamData);

            const parts = nonStreamResponse?.response?.candidates?.[0]?.content?.parts;
            if (!parts || parts.length === 0) {
                logger.warn(`[Antigravity] Claude stream had ${chunks.length} chunk(s) but produced empty parts — first chunk: ${chunks[0]?.slice(0, 300)}`);
            }

            return toGeminiApiResponse(nonStreamResponse.response);
        } catch (error) {
            logger.error('[Antigravity] Claude non-stream execution error:', error.message);
            throw error;
        }
    }

    async * generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();
        logger.info(`[Antigravity Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Antigravity] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.ANTIGRAVITY, {
                    uuid: this.uuid
                });
            }
        }

        // Resolve user-friendly 3.5-flash aliases to their actual Antigravity API model IDs.
        const FLASH_ALIASES_STREAM = {
            'gemini-3.5-flash-high':   'gemini-3-flash-agent',
            'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
        };
        let selectedModel = FLASH_ALIASES_STREAM[model] ?? model;
        if (!this.availableModels.includes(selectedModel)) {
            logger.warn(`[Antigravity] Model '${model}' not found. Using default model: 'gemini-3-flash'`);
            selectedModel = 'gemini-3-flash';
        }

        // 移除 gemini- 前缀以获取实际模型名称（针对 claude 模型）
        const actualModelName = selectedModel.startsWith('gemini-claude-') ? selectedModel.replace('gemini-claude-', 'claude-') : selectedModel;
        logger.info(`[Antigravity] Selected model: ${actualModelName}`);
        // 深拷贝请求体 (structuredClone is faster than JSON parse/stringify)
        const processedRequestBody = ensureRolesInContents(structuredClone(requestBody), actualModelName);

        // 将处理后的请求体转换为 Antigravity 格式
        const payload = geminiToAntigravity(actualModelName, { request: processedRequestBody }, this.projectId);

        payload.model = actualModelName;
        // console.error("DEBUG PAYLOAD REQUEST KEYS: ", Object.keys(payload.request));

        const stream = this.streamApi('streamGenerateContent', payload);
        for await (const chunk of stream) {
            yield toGeminiApiResponse(chunk.response);
        }
    }

    isExpiryDateNear() {
        try {
            const nearMinutes = 20;
            const { message, isNearExpiry } = formatExpiryLog('Antigravity', this.authClient.credentials.expiry_date, nearMinutes);
            logger.info(message);
            return isNearExpiry;
        } catch (error) {
            logger.error(`[Antigravity] Error checking expiry date: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取模型配额信息 (返回原始 API 数据)
     * @returns {Promise<Object>} 原始配额信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        
        for (const baseURL of this.baseURLs) {
            try {
                const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
                const requestOptions = {
                    url: modelsURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': this.userAgent
                    },
                    responseType: 'json',
                    body: JSON.stringify({ project: this.projectId })
                };

                this._applySidecar(requestOptions);
                const res = await this.authClient.request(requestOptions);
                if (res.data) {
                    return {
                        ...res.data,
                        tierId: this.tierId,
                        account: this.accountEmail
                    };
                }
            } catch (error) {
                logger.error(`[Antigravity] Failed to fetch usage limits from ${baseURL}:`, error.message);
            }
        }
        throw new Error('Failed to fetch usage limits from all endpoints');
    }

}
