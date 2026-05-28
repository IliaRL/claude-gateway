// request-handlers.js — HTTP request orchestration extracted from common.js
// Owns: stream/unary content generation, model list, request dispatching,
//       last-model file updates, system-prompt management glue.
// Error formatters live in error-handling.js and are imported below.

import { promises as fs } from 'fs';
import logger from './logger.js';
import { convertData, getOpenAIStreamChunkStop } from '../convert/convert.js';
import { ProviderStrategyFactory } from './provider-strategies.js';
import { getPluginManager } from '../core/plugin-manager.js';
import { MODEL_MAX_OUTPUT_TOKENS, MODEL_CONTEXT_WINDOWS, GEMINI_DEFAULT_MAX_TOKENS } from '../converters/utils.js';
import { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import {
    handleUnifiedResponse,
    getClientIp,
    isAuthorized,
    getRequestBody,
    ensureValidStatusCode,
    getErrorStatusCode,
    getRateLimitCooldownRecoveryTime,
} from './network-utils.js';
import { logConversation, FETCH_SYSTEM_PROMPT_FILE, INPUT_SYSTEM_PROMPT_FILE } from './logging-utils.js';
import { getProtocolPrefix, ENDPOINT_TYPE, resolveCustomModelRouting, extractResponseText, extractPromptText, extractSystemPromptFromRequestBody } from './model-utils.js';
import {
    usesManagedModelList,
    getConfiguredSupportedModels,
    getCustomModelConfig,
    getCustomModelActualProvider,
    getCustomModelListProvider,
    normalizeModelIds,
} from '../providers/provider-models.js';
import { handleError, createErrorResponse, createStreamErrorResponse } from './error-handling.js';
import { recordFallbackStep, isReasoningModel, isThinkingEnabled } from './trace-buffer.js';
import { getCacheKey, getCache, setCache } from './response-cache.js';

/**
 * Retrieve the active diagnostic trace from CONFIG, if present.
 * Returns null when no trace is attached (e.g. internal/health-check requests).
 */
function _getTrace(CONFIG) {
    return CONFIG?._trace || null;
}

// ==================== Private helpers (handler-internal) ====================

/**
 * 获取指定提供商类型下，所有节点配置的已选模型列表（去重聚合）
 */
function getConfiguredSupportedModelsFromPool(providerPoolManager, providerType) {
    if (!providerPoolManager?.providerStatus || !Object.hasOwn(providerPoolManager.providerStatus, providerType)) {
        return [];
    }

    return [...new Set(
        providerPoolManager.providerStatus[providerType]
            .flatMap(providerStatus => getConfiguredSupportedModels(providerType, providerStatus.config))
    )].sort((a, b) => a.localeCompare(b));
}

function getCustomModelEntriesForProvider(config, providerType = null, options = {}) {
    const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
    const entries = [];

    customModels.forEach(modelConfig => {
        if (!modelConfig?.id) {
            return;
        }

        const modelProvider = getCustomModelListProvider(modelConfig);
        const actualProvider = getCustomModelActualProvider(modelConfig);
        const isMatch = !providerType ||
            modelProvider === providerType ||
            (modelProvider && providerType.startsWith(modelProvider + '-'));

        if (!isMatch) {
            return;
        }

        const modelId = modelConfig.id;
        if (!modelId) {
            return;
        }

        const responseId = options.prefixProvider && modelProvider
            ? `${modelProvider}:${modelId}`
            : modelId;

        entries.push({
            id: responseId,
            modelId,
            provider: modelProvider || providerType || MODEL_PROVIDER.AUTO,
            actualProvider: actualProvider || modelProvider || providerType || MODEL_PROVIDER.AUTO,
            config: modelConfig
        });
    });

    return entries;
}

function appendCustomModelsToModelList(clientModelList, customEntries, providerType, listEndpointType) {
    const entries = Array.isArray(customEntries) ? customEntries : [];
    const hasMetadataValue = (value) => value !== undefined && value !== null;

    if (!entries.length) {
        return clientModelList;
    }

    if (listEndpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
        const models = Array.isArray(clientModelList?.models) ? clientModelList.models : [];

        entries.forEach(entry => {
            const existingModel = models.find(model => {
                const existingId = model?.baseModelId || model?.name;
                if (!existingId) return false;
                const normalizedId = existingId.startsWith('models/') ? existingId.substring(7) : existingId;
                return normalizedId === entry.id;
            });
            if (existingModel) {
                existingModel.displayName = entry.config.name || existingModel.displayName || entry.id;
                existingModel.description = entry.config.description || existingModel.description || `Model ${entry.modelId} provided by ${entry.provider || providerType}`;
                if (hasMetadataValue(entry.config.contextLength)) existingModel.inputTokenLimit = entry.config.contextLength;
                if (hasMetadataValue(entry.config.maxTokens)) existingModel.outputTokenLimit = entry.config.maxTokens;
                return;
            }

            const modelResponse = {
                name: `models/${entry.id}`,
                baseModelId: entry.id,
                version: 'v1',
                displayName: entry.config.name || entry.id,
                description: entry.config.description || `Model ${entry.modelId} provided by ${entry.provider || providerType}`,
                supportedGenerationMethods: ['generateContent', 'countTokens']
            };

            if (hasMetadataValue(entry.config.contextLength)) modelResponse.inputTokenLimit = entry.config.contextLength;
            if (hasMetadataValue(entry.config.maxTokens)) modelResponse.outputTokenLimit = entry.config.maxTokens;

            models.push(modelResponse);
        });

        return {
            ...clientModelList,
            models
        };
    }

    if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
        const models = Array.isArray(clientModelList?.data) ? clientModelList.data : [];

        entries.forEach(entry => {
            const existingModel = models.find(model => model?.id === entry.id);
            if (existingModel) {
                // 更新现有模型的元数据
                if (entry.config.name) existingModel.display_name = entry.config.name;
                if (entry.config.description) existingModel.description = entry.config.description;
                if (hasMetadataValue(entry.config.contextLength)) existingModel.context_length = entry.config.contextLength;
                if (hasMetadataValue(entry.config.maxTokens)) existingModel.max_tokens = entry.config.maxTokens;
                return;
            }

            // 添加新模型
            const modelResponse = {
                id: entry.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: entry.provider || providerType || 'custom',
                display_name: entry.config.name || entry.id
            };

            if (entry.config.description) modelResponse.description = entry.config.description;
            if (hasMetadataValue(entry.config.contextLength)) modelResponse.context_length = entry.config.contextLength;
            if (hasMetadataValue(entry.config.maxTokens)) modelResponse.max_tokens = entry.config.maxTokens;

            models.push(modelResponse);
        });

        return {
            ...clientModelList,
            object: 'list',
            data: models
        };
    }

    return clientModelList;
}

/**
 * Applies a short (60s) PER-ACCOUNT model-level cooldown for 400 errors so other pool
 * accounts can rotate in. A 400 on one account does not mean the model is broken for
 * every other account on the same provider type.
 *
 * 429/5xx errors use the default 5-minute cooldown set elsewhere.
 */
function _applyBadRequestCooldown(providerPoolManager, toProvider, model, status, error, pooluuid) {
    if ((error?.response?.status === 400 || status === 400) && providerPoolManager && toProvider && model) {
        try {
            if (pooluuid && typeof providerPoolManager.markModelCooldownForAccount === 'function') {
                providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, 60000);
            } else if (typeof providerPoolManager.markModelCooldown === 'function') {
                // Fallback: provider-type-wide cooldown (legacy behavior) only if uuid unavailable.
                providerPoolManager.markModelCooldown(toProvider, model, 60000);
            }
            // If this model has a fallback mapping, also apply a provider-level cooldown so that
            // _hasAnyHealthyAccountForModel returns false immediately and Strategy B (modelFallbackMapping)
            // fires on the very next retry — instead of cycling all accounts before falling back.
            if (providerPoolManager.modelFallbackMapping?.[model] &&
                typeof providerPoolManager.markModelCooldown === 'function') {
                providerPoolManager.markModelCooldown(toProvider, model, 60000);
            }
        } catch (e) {
            logger.warn(`[Provider Pool] markModelCooldown failed: ${e.message}`);
        }
        return true;
    }
    return false;
}

function getPluginHookRequestId(config) {
    return config?._monitorRequestId || null;
}

function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

/**
 * Reconverts the original request body for a new provider during retry.
 */
async function _reconvertRequestBodyForRetry(retryContext, fromProvider, newProvider, CONFIG) {
    if (!retryContext || !retryContext.originalRequestBody) {
        return null;
    }
    let nextRequestBody = { ...retryContext.originalRequestBody };
    
    if (CONFIG._monitorRequestId) {
        nextRequestBody._monitorRequestId = CONFIG._monitorRequestId;
    }
    if (CONFIG.requestBaseUrl) {
        nextRequestBody._requestBaseUrl = CONFIG.requestBaseUrl;
    }
    
    if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(newProvider)) {
        logger.info(`[Retry Convert] Reconverting request from ${fromProvider} to ${newProvider}`);
        nextRequestBody = convertData(nextRequestBody, 'request', fromProvider, newProvider);
    }
    
    nextRequestBody = await _applySystemPromptFromFile(CONFIG, nextRequestBody, newProvider);
    await _manageSystemPrompt(nextRequestBody, newProvider);
    
    return nextRequestBody;
}

async function _applySystemPromptFromFile(config, requestBody, toProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(toProvider));
    return strategy.applySystemPromptFromFile(config, requestBody);
}

/**
 * 应用自定义模型参数到请求体
 */
function _applyCustomModelParameters(requestBody, customConfig, provider) {
    const protocol = getProtocolPrefix(provider);
    const hasConfiguredValue = (value) => value !== undefined && value !== null;

    const mappings = {
        temperature: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.temperature'
        },
        maxTokens: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'max_tokens',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'max_output_tokens',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'max_tokens',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.maxOutputTokens'
        },
        topP: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.topP'
        }
    };

    const setNestedProperty = (obj, path, value) => {
        const parts = path.split('.');
        let curr = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!curr[parts[i]]) curr[parts[i]] = {};
            curr = curr[parts[i]];
        }
        curr[parts[parts.length - 1]] = value;
        logger.debug(`[Custom Model] Applied nested parameter ${path}=${value}`);
    };

    Object.keys(mappings).forEach(key => {
        const value = customConfig[key];
        const targetPath = mappings[key][protocol];

        if (hasConfiguredValue(value) && targetPath) {
            if (targetPath.includes('.')) {
                setNestedProperty(requestBody, targetPath, value);
            } else {
                requestBody[targetPath] = value;
                logger.debug(`[Custom Model] Applied ${key}=${value} to request (${targetPath})`);
            }
        }
    });
}

// ==================== Exported handlers ====================

/**
 * Updates a temporary file with the ID of the last model used.
 * Used for accurate shell statusline reporting.
 */
export async function updateLastModelFile(model, provider = null, customName = null, requestedModel = null, trace = null) {
    try {
        // Strip OpenRouter-style variant suffixes like :free, :nitro, :beta
        // e.g. "openai/gpt-oss-120b:free" -> "openai/gpt-oss-120b"
        const baseModelId = model.replace(/:[^/]+$/, '');
        const maxOutput = MODEL_MAX_OUTPUT_TOKENS[model] ?? MODEL_MAX_OUTPUT_TOKENS[baseModelId] ?? GEMINI_DEFAULT_MAX_TOKENS;
        const contextWindow = MODEL_CONTEXT_WINDOWS[model] ?? MODEL_CONTEXT_WINDOWS[baseModelId] ?? 200000;
        const payload = JSON.stringify({
            model,
            maxOutput,
            contextWindow,
            provider: provider || null,
            customName: customName || null,
            requestedModel: requestedModel || null,
            // Diagnostic fields sourced from per-request trace (null when no trace available)
            latencyMs: trace?.totalUpstreamMs ?? null,
            ttftMs: trace?.upstreamTTFTMs ?? null,
            fallbackCount: trace?.fallbackCount ?? 0,
            isDowngrade: Array.isArray(trace?.fallbackSteps) && trace.fallbackSteps.some(s => s.isModelDowngrade === true),
            finalProvider: trace?.provider ?? provider ?? null,
            inputTokens: trace?.inputTokens ?? null,
            outputTokens: trace?.outputTokens ?? null,
        });
        const tmpPath = '/tmp/aiclient_last_model.tmp';
        await fs.writeFile(tmpPath, payload);
        await fs.rename(tmpPath, '/tmp/aiclient_last_model');
        broadcastEvent('request_complete', JSON.parse(payload));
    } catch (err) {
        // Silently ignore errors
    }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
    let fullResponseText = '';
    let fullResponseJson = '';
    let fullOldResponseJson = '';
    let responseClosed = false;
    let anyDataSent = retryContext?.anyDataSent || false; // 跟踪是否已向客户端发送过任何数据

    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG;
    const isRetry = currentRetry > 0;

    // 使用共享的 clientDisconnected 状态（如果是重试，继承上层的状态）
    let clientDisconnected = retryContext?.clientDisconnected || { value: false };
    if (!isRetry) {
        clientDisconnected = { value: false }; // 使用对象引用，便于在递归中共享状态
    }

    // 监听客户端断开连接事件（命名函数，便于移除）
    const onClientClose = () => {
        clientDisconnected.value = true;
        logger.info('[Stream] Client disconnected, stopping stream processing');
    };

    const onClientError = (err) => {
        clientDisconnected.value = true;
        logger.error('[Stream] Response stream error:', err.message);
    };

    // 只在首次请求时注册事件监听器（避免重试时重复注册）
    if (!isRetry) {
        res.on('close', onClientClose);
        res.on('error', onClientError);
    }

    // 只在首次请求时发送响应头，重试时跳过（响应头已发送）
    if (!isRetry) {
        const metadata = {
            actualProvider: toProvider,
            actualModel: model,
            isFallback: retryContext?.isFallback || false,
            uuid: pooluuid
        };
        await handleUnifiedResponse(res, '', true, 200, metadata);
    }

    let hasToolCall = false;
    let hasMessageStop = false; // 跟踪是否已经发送过结束标志（message_stop / done）

    // ---- Diagnostic timing ----
    const _trace = _getTrace(CONFIG);
    const _upstreamStartedAt = Date.now();
    const _ttftBaseline = (CONFIG && typeof CONFIG.TTFT_TIMEOUT_MS === 'number') ? CONFIG.TTFT_TIMEOUT_MS : 10000;
    const _ttftOverrides = (CONFIG && CONFIG.TTFT_TIMEOUT_OVERRIDES) ? CONFIG.TTFT_TIMEOUT_OVERRIDES : {};
    const _ttftThresholdMs = _ttftOverrides[model] ?? _ttftBaseline;
    let _firstChunkSeen = false;
    let _ttftTimer = null;
    // Track whether this request is reasoning-exempt (no abort even if TTFT exceeded).
    const _isReasoning = isReasoningModel(model) || (_trace && _trace._thinkingEnabled);

    try {
        // The service returns a stream in its native format (toProvider).
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
        requestBody.model = model;
        const nativeStream = await service.generateContentStream(model, requestBody);
        // Start TTFT timer immediately after upstream call returns the stream object.
        // For non-reasoning models, this aborts via stream-error if no first chunk in N ms.
        _ttftTimer = setTimeout(() => {
            if (_firstChunkSeen) return;
            if (_isReasoning) {
                logger.warn(`[TTFT-WARN] ${model} exceeded ${_ttftThresholdMs}ms TTFT threshold — reasoning model, continuing...`);
                if (_trace) _trace.ttftWarning = `exceeded ${_ttftThresholdMs}ms (reasoning, not aborted)`;
                return;
            }
            // Non-reasoning model: trigger fallback by injecting an error into the stream loop.
            logger.error(`[TTFT-ABORT] ${model} exceeded ${_ttftThresholdMs}ms TTFT — aborting and triggering fallback`);
            if (_trace) {
                _trace.ttftAborted = true;
                _trace.status = 'timeout';
            }
            try {
                // Mark the upstream stream as errored. Most async iterators support .return() to break out;
                // also try .destroy()/.cancel() defensively for various adapter implementations.
                if (typeof nativeStream?.return === 'function') nativeStream.return();
                if (typeof nativeStream?.destroy === 'function') nativeStream.destroy(new Error(`TTFT timeout (${_ttftThresholdMs}ms)`));
                if (typeof nativeStream?.cancel === 'function') nativeStream.cancel();
            } catch (_) { /* best-effort */ }
        }, _ttftThresholdMs);
        const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
        // 为每个请求生成唯一 ID，用于在单例 converter 中隔离并发流状态
        const streamRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

        for await (const nativeChunk of nativeStream) {
            // First-chunk hook → records TTFT and clears the TTFT abort timer.
            if (!_firstChunkSeen) {
                _firstChunkSeen = true;
                if (_ttftTimer) { clearTimeout(_ttftTimer); _ttftTimer = null; }
                if (_trace && _trace.upstreamTTFTMs == null) {
                    _trace.upstreamTTFTMs = Date.now() - _upstreamStartedAt;
                }
            }
            // 检查客户端是否已断开连接
            if (clientDisconnected.value) {
                logger.info('[Stream] Stopping iteration due to client disconnect');
                break;
            }

            // Extract text for logging purposes
            const chunkText = extractResponseText(nativeChunk, toProvider);
            if (chunkText && !Array.isArray(chunkText)) {
                fullResponseText += chunkText;
            }

            // Capture token usage from native chunk for status line reporting.
            // Claude: message_start carries input_tokens; message_delta carries final output_tokens.
            // OpenAI: final chunk may carry usage.prompt_tokens / usage.completion_tokens.
            if (_trace && nativeChunk) {
                const msgUsage = nativeChunk.message?.usage;           // Claude message_start
                const deltaUsage = nativeChunk.usage;                  // Claude message_delta or OpenAI
                if (msgUsage?.input_tokens != null)  _trace.inputTokens  = msgUsage.input_tokens;
                if (deltaUsage?.output_tokens != null) _trace.outputTokens = deltaUsage.output_tokens;
                if (deltaUsage?.prompt_tokens != null)     _trace.inputTokens  = deltaUsage.prompt_tokens;
                if (deltaUsage?.completion_tokens != null) _trace.outputTokens = deltaUsage.completion_tokens;
            }

            // Convert the complete chunk object to the client's format (fromProvider), if necessary.
            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model, streamRequestId)
                : nativeChunk;

            // 监控钩子：流式响应分块
            const hookRequestId = getPluginHookRequestId(CONFIG);
            if (hookRequestId) {
                try {
                    const pluginManager = getPluginManager();
                    await pluginManager.executeHook('onStreamChunk', {
                        nativeChunk,
                        chunkToSend,
                        fromProvider,
                        toProvider,
                        model,
                        requestId: hookRequestId
                    });
                } catch (e) {}
            }

            if (!chunkToSend) {
                continue;
            }

            // 处理 chunkToSend 可能是数组或对象的情况
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                // 再次检查客户端连接状态
                if (clientDisconnected.value) {
                    break;
                }

                // [FIX] 跟踪工具调用并在结束时修正 finish_reason
                // OpenAI 格式
                if (chunk.choices?.[0]?.delta?.tool_calls || chunk.choices?.[0]?.finish_reason === 'tool_calls') {
                    hasToolCall = true;
                }
                // Claude 格式
                if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
                    hasToolCall = true;
                }
                if (chunk.type === 'message_delta' && (chunk.delta?.stop_reason === 'tool_use' || chunk.stop_reason === 'tool_use')) {
                    hasToolCall = true;
                }
                // Gemini 格式
                if (chunk.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
                    hasToolCall = true;
                }

                // 如果之前有工具调用，且当前 chunk 是正常结束，修正为 tool_calls / tool_use / FINISH_REASON_TOOL_CALLS
                if (hasToolCall && needsConversion) {
                    if (chunk.choices?.[0]?.finish_reason === 'stop') {
                        chunk.choices[0].finish_reason = 'tool_calls';
                    } else if (chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'end_turn') {
                        chunk.delta.stop_reason = 'tool_use';
                    } else if (chunk.candidates?.[0]?.finishReason === 'STOP' || chunk.candidates?.[0]?.finishReason === 'stop') {
                        // 修正 Gemini 原生格式的结束原因
                        chunk.candidates[0].finishReason = 'TOOL_CALLS';
                    }
                }

                // 防止重复发送结束标志
                // OpenAI: choices[].finish_reason
                // Claude: message_stop
                // OpenAI Responses: done
                // Gemini: candidates[].finishReason（如 STOP / MAX_TOKENS / SAFETY 等）
                if (
                    chunk?.choices?.some(choice => choice?.finish_reason) ||
                    chunk?.type === 'message_stop' ||
                    chunk?.type === 'done' ||
                    chunk?.candidates?.some(candidate => candidate?.finishReason)
                ) {
                    hasMessageStop = true;
                }

                if (addEvent) {
                    // fullOldResponseJson += chunk.type+"\n";
                    // fullResponseJson += chunk.type+"\n";
                    if (!clientDisconnected.value && !res.writableEnded) {
                        try {
                            const okEvent = res.write(`event: ${chunk.type}\n`);
                            anyDataSent = true;
                            if (okEvent === false && !clientDisconnected.value) {
                                await new Promise((resolve) => res.once('drain', resolve));
                            }
                        } catch (writeErr) {
                            logger.error('[Stream] Failed to write event:', writeErr.message);
                            clientDisconnected.value = true;
                            break;
                        }
                    }
                    // logger.info(`event: ${chunk.type}\n`);
                }

                // fullOldResponseJson += JSON.stringify(chunk)+"\n";
                // fullResponseJson += JSON.stringify(chunk)+"\n\n";
                if (!clientDisconnected.value && !res.writableEnded) {
                    try {
                        const okData = res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        anyDataSent = true;
                        if (okData === false && !clientDisconnected.value) {
                            await new Promise((resolve) => res.once('drain', resolve));
                        }
                    } catch (writeErr) {
                        logger.error('[Stream] Failed to write data:', writeErr.message);
                        clientDisconnected.value = true;
                        break;
                    }
                }
                // logger.info(`data: ${JSON.stringify(chunk)}\n`);
            }
        }

        // 流式请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            const customNameDisplay = customName ? `, ${customName}` : '';
            logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful stream request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
            // Update last model file for statusline accuracy
            updateLastModelFile(model, toProvider, customName, retryContext?.originalModel || null, _trace);
        }
        // Record total upstream time on success.
        if (_trace) {
            _trace.totalUpstreamMs = Date.now() - _upstreamStartedAt;
            _trace.provider = toProvider;
            _trace.model = model;
        }

    }  catch (error) {
        if (_ttftTimer) { clearTimeout(_ttftTimer); _ttftTimer = null; }
        if (_trace && _trace.totalUpstreamMs == null) {
            _trace.totalUpstreamMs = Date.now() - _upstreamStartedAt;
        }
        logger.error('\n[Server] Error during stream processing:', error.stack);

        // 如果客户端已断开，不需要发送错误响应
        if (clientDisconnected.value) {
            logger.info('[Stream] Skipping error response due to client disconnect');
            responseClosed = true;
            return;
        }

        // 如果已经发送了数据（包括 metadata），不进行重试（避免响应数据损坏或顺序错误）
        if (anyDataSent) {
            logger.info(`[Stream Retry] Cannot retry: data already sent to client`);
            // 直接发送错误并结束
            const errorPayload = createStreamErrorResponse(error, fromProvider);
            if (!res.writableEnded) {
                try {
                    res.write(errorPayload);
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write error response:', writeErr.message);
                }
            }
            responseClosed = true;
            return;
        }

        // 获取状态码（用于日志记录，不再用于判断是否重试）
        const status = getErrorStatusCode(error);

        // 检查是否应该跳过错误计数（用于 429/5xx 等需要直接切换凭证的情况）
        const skipErrorCount = error.skipErrorCount === true;
        // 检查是否应该切换凭证（用于 429/5xx/402/403 等情况）
        const shouldSwitchCredential = error.shouldSwitchCredential === true;

        // 检查凭证是否已在底层被标记为不健康（避免重复标记）
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
        if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
            logger.info(`[Provider Pool] Applying 429 cooldown for ${toProvider} (${pooluuid}) until ${rateLimitRecoveryTime.toISOString()}`);
            providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
                uuid: pooluuid
            }, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
            credentialMarkedUnhealthy = true;
        }

        // 如果底层未标记，且不跳过错误计数，则在此处标记
        if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
            // 400/413 = client/request error, 404 = model not available on this project.
            // None of these should mark the whole account unhealthy — apply model cooldown instead.
            if (error.response?.status === 400 || status === 400) {
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status 400 (client error)`);
            } else if (error.response?.status === 413 || status === 413) {
                // 413 = payload too large (e.g. GitHub Models context limit). Request-level error,
                // not an account fault — apply a short per-model cooldown and move on.
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to 413 — applying short model cooldown for ${model}`);
                if (model) providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, 60000);
                credentialMarkedUnhealthy = true;
            } else if ((error.response?.status === 404 || status === 404) && model) {
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to 404 — applying model cooldown for ${model}`);
                providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model);
                credentialMarkedUnhealthy = true;
            } else if (error.message?.includes('TTFT timeout')) {
                // TTFT timeout: per-model cooldown, not full account blackout
                const ttftCooldownMs = 30_000;
                if (typeof providerPoolManager?.markModelCooldownForAccount === 'function') {
                    try {
                        providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, ttftCooldownMs);
                        credentialMarkedUnhealthy = true;
                        logger.warn(`[TTFT] Per-model cooldown applied: ${toProvider}/${pooluuid?.slice(0, 8)} for model ${model} (${ttftCooldownMs}ms)`);
                    } catch (cooldownErr) {
                        logger.warn(`[TTFT] markModelCooldownForAccount failed: ${cooldownErr.message}`);
                        credentialMarkedUnhealthy = true;
                    }
                }
            } else if (status === 403 || status === 429) {
                logger.info(`[Provider Pool] Marking ${toProvider} as permanently unhealthy due to ${status} error`);
                providerPoolManager.markProviderUnhealthyImmediately(toProvider, { uuid: pooluuid }, error.message);
                credentialMarkedUnhealthy = true;
            } else {
                logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to stream error (status: ${status || 'unknown'})`);
                // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
                providerPoolManager.markProviderUnhealthy(toProvider, {
                    uuid: pooluuid
                }, error.message);
                credentialMarkedUnhealthy = true;
            }
        }

        if (_applyBadRequestCooldown(providerPoolManager, toProvider, model, status, error, pooluuid)) {
            credentialMarkedUnhealthy = true;
        }

        // 如果需要切换凭证（无论是否标记不健康），都设置标记以触发重试
        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true; // 触发下面的重试逻辑
        }

        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            // Small jitter to avoid stampede when multiple concurrent requests switch at once.
            const randomDelay = Math.floor(Math.random() * 100); // 0-100ms
            logger.info(`[Stream Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                // 使用 acquireSlot: true 以占用新凭证的并发插槽
                const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true });

                if (result && result.service) {
                    logger.info(`[Stream Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);

                    // Record fallback step on the trace.
                    if (_trace) {
                        recordFallbackStep(_trace, {
                            fromProvider: toProvider,
                            toProvider: result.actualProviderType || toProvider,
                            reason: error?.message ? error.message.slice(0, 200) : 'credential-rotation',
                            errorCode: status || null,
                            penaltyMs: Date.now() - _upstreamStartedAt,
                        });
                        // When PROMPT_LOG_MODE=file, persist fallback chain inline.
                        if (PROMPT_LOG_MODE === 'file') {
                            try {
                                await logConversation('fallback', JSON.stringify({
                                    requestId: _trace.requestId,
                                    step: _trace.fallbackCount,
                                    from: toProvider,
                                    to: result.actualProviderType,
                                    reason: error?.message?.slice(0, 200),
                                    status,
                                }), PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
                            } catch (_) { /* logging is best-effort */ }
                        }
                    }

                    // 使用新服务重试
                    const newRetryContext = {
                        ...retryContext,
                        CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries,
                        clientDisconnected,  // 传递断开状态
                        anyDataSent,          // 传递数据发送状态
                        isFallback: result.isFallback || retryContext?.isFallback || false
                    };

                    // 递归调用，使用新的服务
                    let nextRequestBody = requestBody;
                    if (retryContext && retryContext.originalRequestBody) {
                        nextRequestBody = await _reconvertRequestBodyForRetry(retryContext, fromProvider, result.actualProviderType || toProvider, CONFIG) || requestBody;
                    }

                    return await handleStreamRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        nextRequestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid,
                        result.serviceConfig?.customName || customName,
                        newRetryContext
                    );
                } else {
                    logger.info(`[Stream Retry] No healthy credential available for retry.`);
                }
            } catch (retryError) {
                logger.error(`[Stream Retry] Failed to get alternative service:`, retryError.message);
            }
        }

        // 使用新方法创建符合 fromProvider 格式的流式错误响应
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        if (!clientDisconnected.value && !res.writableEnded) {
            try {
                res.write(errorPayload);
                res.end();
            } catch (writeErr) {
                logger.error('[Stream] Failed to write error response:', writeErr.message);
            }
        }
        responseClosed = true;
    } finally {
        // 释放并发插槽
        if (providerPoolManager && pooluuid) {
            providerPoolManager.releaseSlot(toProvider, pooluuid);
        }

        // 只在首次请求时移除事件监听器（避免重试时误删）
        if (!isRetry) {
            res.off('close', onClientClose);
            res.off('error', onClientError);
        }

        // 只在非重试或重试失败时才发送结束标记
        // 如果是重试成功，递归调用会处理结束标记
        if (!responseClosed && !clientDisconnected.value && !isRetry) {
            // 根据客户端协议发送相应的流式结束标记
            const clientProtocol = getProtocolPrefix(fromProvider);
            if (!res.writableEnded) {
                try {
                    if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI) {
                        if (!hasMessageStop) {
                            res.write('data: [DONE]\n\n');
                            hasMessageStop = true;
                        }
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
                        // OpenAI Responses 以 response.completed/response.incomplete（或 error）作为结束事件。
                        // 连接关闭即表示流结束；不要再追加 `event: done` + `data: {}`，否则会触发下游类型校验失败（AI_TypeValidationError）。
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
                        if (!hasMessageStop) {
                            res.write('event: message_stop\n');
                            res.write('data: {"type":"message_stop"}\n\n');
                            hasMessageStop = true;
                        }
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
                        if (!hasMessageStop) {
                            res.write('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
                            hasMessageStop = true;
                        }
                    }
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write completion marker:', writeErr.message);
                }
            }
        }

        // 只在首次请求时记录日志（避免重试时重复记录）
        if (!isRetry) {
            await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        }
    }
}


export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG;

    // ---- Diagnostic timing (unary path) ----
    const _trace = _getTrace(CONFIG);
    const _upstreamStartedAt = Date.now();

    try{
        // The service returns the response in its native format (toProvider).
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
        requestBody.model = model;

        // Response cache check — only on initial (non-retry) unary requests.
        // Prevents quota drain when identical requests are retried or duplicated within 30s.
        const _cacheKey = currentRetry === 0 ? getCacheKey(requestBody, model) : null;
        if (_cacheKey) {
            const cached = getCache(_cacheKey);
            if (cached) {
                logger.info(`[ResponseCache] Cache HIT for model=${model} — serving stored response`);
                const metadata = { actualProvider: toProvider, actualModel: model, isFallback: false, uuid: pooluuid };
                await handleUnifiedResponse(res, cached, false, 200, { ...metadata, cacheHit: true });
                return;
            }
        }

        const nativeResponse = await service.generateContent(model, requestBody);
        // For unary, TTFT == total upstream time (single shot).
        if (_trace) {
            const elapsed = Date.now() - _upstreamStartedAt;
            if (_trace.upstreamTTFTMs == null) _trace.upstreamTTFTMs = elapsed;
            _trace.totalUpstreamMs = elapsed;
            _trace.provider = toProvider;
            _trace.model = model;
            // Capture token usage from unary response (Claude or OpenAI format)
            const u = nativeResponse?.usage;
            if (u) {
                if (u.input_tokens != null)     _trace.inputTokens  = u.input_tokens;
                if (u.output_tokens != null)    _trace.outputTokens = u.output_tokens;
                if (u.prompt_tokens != null)    _trace.inputTokens  = u.prompt_tokens;
                if (u.completion_tokens != null) _trace.outputTokens = u.completion_tokens;
            }
        }
        const responseText = extractResponseText(nativeResponse, toProvider);

        // Convert the response back to the client's format (fromProvider), if necessary.
        let clientResponse = nativeResponse;
        if (needsConversion) {
            logger.info(`[Response Convert] Converting response from ${toProvider} to ${fromProvider}`);
            clientResponse = convertData(nativeResponse, 'response', toProvider, fromProvider, model);
        }

        // 监控钩子：非流式响应
        const hookRequestId = getPluginHookRequestId(CONFIG);
        if (hookRequestId) {
            try {
                const pluginManager = getPluginManager();
                await pluginManager.executeHook('onUnaryResponse', {
                    nativeResponse,
                    clientResponse,
                    fromProvider,
                    toProvider,
                    model,
                    requestId: hookRequestId
                });
            } catch (e) {}
        }

        //logger.info(`[Response] Sending response to client: ${JSON.stringify(clientResponse)}`);
        const clientResponseBody = JSON.stringify(clientResponse);
        // Store in response cache for deduplication of identical subsequent requests
        if (_cacheKey) setCache(_cacheKey, clientResponseBody);
        const metadata = {
            actualProvider: toProvider,
            actualModel: model,
            isFallback: retryContext?.isFallback || false,
            uuid: pooluuid
        };
        await handleUnifiedResponse(res, clientResponseBody, false, 200, metadata);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

        // 一元请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            const customNameDisplay = customName ? `, ${customName}` : '';
            logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful unary request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
            // Update last model file for statusline accuracy
            updateLastModelFile(model, toProvider, customName, retryContext?.originalModel || null, _trace);
        }
    } catch (error) {
        logger.error('\n[Server] Error during unary processing:', error.stack);

        // 获取状态码（用于日志记录，不再用于判断是否重试）
        const status = getErrorStatusCode(error);

        // 检查是否应该跳过错误计数（用于 429/5xx 等需要直接切换凭证的情况）
        const skipErrorCount = error.skipErrorCount === true;
        // 检查是否应该切换凭证（用于 429/5xx/402/403 等情况）
        const shouldSwitchCredential = error.shouldSwitchCredential === true;

        // 检查凭证是否已在底层被标记为不健康（避免重复标记）
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
        if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
            logger.info(`[Provider Pool] Applying 429 cooldown for ${toProvider} (${pooluuid}) until ${rateLimitRecoveryTime.toISOString()}`);
            providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
                uuid: pooluuid
            }, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
            credentialMarkedUnhealthy = true;
        }

        // 如果底层未标记，且不跳过错误计数，则在此处标记
        if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
            // 400/413 = client/request error, 404 = model not available on this project.
            // None of these should mark the whole account unhealthy — apply model cooldown instead.
            if (error.response?.status === 400 || status === 400) {
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status 400 (client error)`);
            } else if (error.response?.status === 413 || status === 413) {
                // 413 = payload too large (e.g. GitHub Models context limit). Request-level error,
                // not an account fault — apply a short per-model cooldown and move on.
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to 413 — applying short model cooldown for ${model}`);
                if (model) providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, 60000);
                credentialMarkedUnhealthy = true;
            } else if ((error.response?.status === 404 || status === 404) && model) {
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to 404 — applying model cooldown for ${model}`);
                providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model);
                credentialMarkedUnhealthy = true;
            } else if (status === 403 || status === 429) {
                logger.info(`[Provider Pool] Marking ${toProvider} as permanently unhealthy due to ${status} error`);
                providerPoolManager.markProviderUnhealthyImmediately(toProvider, { uuid: pooluuid }, error.message);
                credentialMarkedUnhealthy = true;
            } else {
                logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to unary error (status: ${status || 'unknown'})`);
                // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
                providerPoolManager.markProviderUnhealthy(toProvider, {
                    uuid: pooluuid
                }, error.message);
                credentialMarkedUnhealthy = true;
            }
        }

        if (_applyBadRequestCooldown(providerPoolManager, toProvider, model, status, error, pooluuid)) {
            credentialMarkedUnhealthy = true;
        }

        // 如果需要切换凭证（无论是否标记不健康），都设置标记以触发重试
        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true; // 触发下面的重试逻辑
        }

        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            // Small jitter to avoid stampede when multiple concurrent requests switch at once.
            const randomDelay = Math.floor(Math.random() * 100); // 0-100ms
            logger.info(`[Unary Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                // 使用 acquireSlot: true 以占用新凭证的并发插槽
                const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true });

                if (result && result.service) {
                    logger.info(`[Unary Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);

                    // Record fallback step on the trace.
                    if (_trace) {
                        recordFallbackStep(_trace, {
                            fromProvider: toProvider,
                            toProvider: result.actualProviderType || toProvider,
                            reason: error?.message ? error.message.slice(0, 200) : 'credential-rotation',
                            errorCode: status || null,
                            penaltyMs: Date.now() - _upstreamStartedAt,
                        });
                        if (PROMPT_LOG_MODE === 'file') {
                            try {
                                await logConversation('fallback', JSON.stringify({
                                    requestId: _trace.requestId,
                                    step: _trace.fallbackCount,
                                    from: toProvider,
                                    to: result.actualProviderType,
                                    reason: error?.message?.slice(0, 200),
                                    status,
                                }), PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
                            } catch (_) { /* best-effort */ }
                        }
                    }

                    // 使用新服务重试
                    const newRetryContext = {
                        ...retryContext,
                        CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries,
                        isFallback: result.isFallback || retryContext?.isFallback || false
                    };

                    // 递归调用，使用新的服务
                    let nextRequestBody = requestBody;
                    if (retryContext && retryContext.originalRequestBody) {
                        nextRequestBody = await _reconvertRequestBodyForRetry(retryContext, fromProvider, result.actualProviderType || toProvider, CONFIG) || requestBody;
                    }

                    return await handleUnaryRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        nextRequestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid,
                        result.serviceConfig?.customName || customName,
                        newRetryContext
                    );
                } else {
                    logger.info(`[Unary Retry] No healthy credential available for retry.`);
                }
            } catch (retryError) {
                logger.error(`[Unary Retry] Failed to get alternative service:`, retryError.message);
            }
        }

        // 使用新方法创建符合 fromProvider 格式的错误响应
        const errorResponse = createErrorResponse(error, fromProvider);
        const rawStatusCode = error.status || error.code || (error.response && error.response.status) || 500;
        const statusCode = ensureValidStatusCode(rawStatusCode);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, statusCode);
    } finally {
        // 确保在请求结束或出错时释放插槽
        if (providerPoolManager && pooluuid) {
            providerPoolManager.releaseSlot(toProvider, pooluuid);
        }
    }
}

/**
 * Handles requests for listing available models. It fetches models from the
 * service, transforms them to the format expected by the client (OpenAI, Claude, etc.),
 * and sends the JSON response.
 */
export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid) {
    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];

    try {
        if (!fromProvider) {
            throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
        }

        let clientModelList;

        const buildConfiguredModelListResponse = (models, providerType, listEndpointType) => {
            if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
                return {
                    object: 'list',
                    data: models.map(modelId => {
                        const customConfig = getCustomModelConfig(modelId, providerType);
                        const modelResponse = {
                            id: modelId,
                            object: 'model',
                            created: Math.floor(Date.now() / 1000),
                            owned_by: providerType
                        };

                        // 注入自定义元数据
                        if (customConfig) {
                            if (customConfig.contextLength) modelResponse.context_length = customConfig.contextLength;
                            if (customConfig.maxTokens) modelResponse.max_tokens = customConfig.maxTokens;
                            if (customConfig.description) modelResponse.description = customConfig.description;
                        } else if (MODEL_CONTEXT_WINDOWS[modelId]) {
                            // 注入默认模型上下文长度
                            modelResponse.context_length = MODEL_CONTEXT_WINDOWS[modelId];
                        }

                        return modelResponse;
                    })
                };
            }

            if (listEndpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
                return {
                    models: models.map(modelId => {
                        const customConfig = getCustomModelConfig(modelId, providerType);
                        const modelResponse = {
                            name: `models/${modelId}`,
                            baseModelId: modelId,
                            version: 'v1',
                            displayName: modelId,
                            description: `Model ${modelId} provided by ${providerType}`,
                            supportedGenerationMethods: ['generateContent', 'countTokens']
                        };

                        if (customConfig) {
                            if (customConfig.contextLength) modelResponse.inputTokenLimit = customConfig.contextLength;
                            if (customConfig.maxTokens) modelResponse.outputTokenLimit = customConfig.maxTokens;
                            if (customConfig.description) modelResponse.description = customConfig.description;
                        }

                        return modelResponse;
                    })
                };
            }

            return { data: [] };
        };

        // --- 核心逻辑: 路由模式下的模型聚合 ---
        // 当处于 auto 模式，或者配置了多个默认提供商时，执行聚合
        const isMultiProvider = CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO ||
                               (Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 1);

        if (isMultiProvider && providerPoolManager) {
            logger.info(`[ModelList] Aggregating models for multi-provider mode...`);
            clientModelList = await providerPoolManager.getAllAvailableModels(endpointType);
        } else {
            // --- 单提供商逻辑 ---
            const toProvider = CONFIG.MODEL_PROVIDER;
            const pooledSupportedModels = getConfiguredSupportedModelsFromPool(providerPoolManager, toProvider);
            const configuredSupportedModels = pooledSupportedModels.length > 0
                ? pooledSupportedModels
                : getConfiguredSupportedModels(toProvider, CONFIG);

            if (usesManagedModelList(toProvider) && configuredSupportedModels.length > 0) {
                logger.info(`[ModelList] Returning configured supported models for ${toProvider}: ${configuredSupportedModels.join(', ')}`);
                clientModelList = buildConfiguredModelListResponse(configuredSupportedModels, toProvider, endpointType);
            } else {

            // service 可能未在上层预先注入（例如仅改了路径 provider 前缀），这里兜底获取
            let resolvedService = service;
            if (!resolvedService) {
                const { getApiService } = await import('../services/service-manager.js');
                resolvedService = await getApiService(CONFIG, null, { skipUsageCount: true });
            }

            if (!resolvedService || typeof resolvedService.listModels !== 'function') {
                throw new Error(`[ModelList] Service adapter is unavailable or does not implement listModels() for provider: ${toProvider}`);
            }

            // 1. Get the model list in the backend's native format.
            const nativeModelList = await resolvedService.listModels();

            // 2. Convert the model list to the client's expected format, if necessary.
            clientModelList = nativeModelList;
            if (!getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider))) {
                logger.info(`[ModelList Convert] Converting model list from ${toProvider} to ${fromProvider}`);
                clientModelList = convertData(nativeModelList, 'modelList', toProvider, fromProvider);
            } else {
                logger.info(`[ModelList Convert] Model list format matches. No conversion needed.`);
            }
            }

            const customEntries = getCustomModelEntriesForProvider(CONFIG, toProvider);
            clientModelList = appendCustomModelsToModelList(clientModelList, customEntries, toProvider, endpointType);
        }

        if (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO) {
            const customEntries = getCustomModelEntriesForProvider(CONFIG, null, { prefixProvider: true });
            clientModelList = appendCustomModelsToModelList(clientModelList, customEntries, MODEL_PROVIDER.AUTO, endpointType);
        }

        // logger.info(`[ModelList Response] Sending model list to client: ${JSON.stringify(clientModelList)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientModelList));
    } catch (error) {
        logger.error('\n[Server] Error during model list processing:', error.stack);
        // if (providerPoolManager && pooluuid && CONFIG.MODEL_PROVIDER !== MODEL_PROVIDER.AUTO) {
        //     // 如果是号池模式（且非 auto 模式），并且请求处理失败，则标记当前使用的提供者为不健康
        //     providerPoolManager.markProviderUnhealthy(CONFIG.MODEL_PROVIDER, {
        //         uuid: pooluuid
        //     }, error.message);
        // }
        handleError(res, error, CONFIG.MODEL_PROVIDER, fromProvider);
    }
}


/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the internal Gemini format,
 * logging, and dispatching to the appropriate stream or unary handler.
 */
export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, requestPath = null) {
    const originalRequestBody = await getRequestBody(req);

    if (!originalRequestBody) {
        throw new Error("Request body is missing for content generation.");
    }

    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
        [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];
    // 使用实际的提供商类型（可能是 fallback 后的类型）
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;

    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // 2. Extract model and determine if the request is for streaming.
    let { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);
    CONFIG.originalRequestedModel = model;

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }

    // 2.1. 处理自定义模型映射和别名
    const customModelConfig = getCustomModelConfig(model, CONFIG.MODEL_PROVIDER);
    CONFIG.customConfig = customModelConfig || null;
    if (customModelConfig) {
        const customRouting = resolveCustomModelRouting(model, CONFIG.MODEL_PROVIDER, customModelConfig);
        logger.info(`[Custom Model] Resolved '${model}' to actual model '${customRouting.actualModel}'`);

        if (customRouting.actualProvider && customRouting.actualProvider !== CONFIG.MODEL_PROVIDER) {
            CONFIG.MODEL_PROVIDER = customRouting.actualProvider;
            toProvider = customRouting.actualProvider;
            logger.info(`[Custom Model] Switched provider to '${CONFIG.MODEL_PROVIDER}' based on custom model config`);
        }

        // 映射到实际模型 ID
        if (customRouting.actualModel) {
            model = customRouting.actualModel;
        }
    }

    logger.info(`[Content Generation] Model: ${model}, Stream: ${isStream}`);


    let actualCustomName = CONFIG.customName;

    let isFallbackUsed = false;

    // 2.5. 根据模型选择服务适配器：
    // - service 缺失时（例如上游未预先注入）进行兜底选择
    // - 使用号池/AUTO 时按模型重选并支持 fallback
    // 注意：仅在号池场景开启 acquireSlot，占用并发名额或进入队列
    const shouldSelectByPool = providerPoolManager && (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO || (CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]));
    if (!service || shouldSelectByPool) {
        const { getApiServiceWithFallback } = await import('../services/service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: shouldSelectByPool });

        service = result.service;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;
        actualCustomName = result.serviceConfig?.customName || CONFIG.customName;

        // 如果发生了模型级别的 fallback，需要更新请求使用的模型
        if (result.actualModel && result.actualModel !== model) {
            logger.info(`[Content Generation] Model Fallback: ${model} -> ${result.actualModel}`);
            model = result.actualModel;
            isFallbackUsed = true;
        }

        if (result.isFallback) {
            logger.info(`[Content Generation] Fallback activated: ${CONFIG.MODEL_PROVIDER} -> ${toProvider} (uuid: ${actualUuid})`);
            isFallbackUsed = true;
        } else {
            logger.info(`[Content Generation] Selected service adapter based on model: ${model}`);
        }
    }

    // 1. Convert request body from client format to backend format, if necessary.
    // 使用浅拷贝以避免直接变异 originalRequestBody，保持原始数据的纯净性以供后续钩子使用
    let processedRequestBody = { ...originalRequestBody };

    // 将 _monitorRequestId 注入到 requestBody 中，以便在 service 内部访问
    if (CONFIG._monitorRequestId) {
        processedRequestBody._monitorRequestId = CONFIG._monitorRequestId;
    }

    // 将 requestBaseUrl 注入到 requestBody 中，以便在转换器中使用
    if (CONFIG.requestBaseUrl) {
        processedRequestBody._requestBaseUrl = CONFIG.requestBaseUrl;
    }

    if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)) {
        logger.info(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
        const preConvertBody = processedRequestBody;
        processedRequestBody = convertData(preConvertBody, 'request', fromProvider, toProvider);

        // 保持以 _ 开头的内部属性（如 _monitorRequestId, _requestBaseUrl）
        Object.keys(preConvertBody).forEach(key => {
            if (key.startsWith('_') && processedRequestBody[key] === undefined) {
                processedRequestBody[key] = preConvertBody[key];
            }
        });
    } else {
        logger.info(`[Request Convert] Request format matches backend provider. No conversion needed.`);
    }

    // 为 forward provider 添加原始请求路径作为 endpoint
    if (requestPath && getProtocolPrefix(toProvider) === MODEL_PROTOCOL_PREFIX.FORWARD) {
        logger.info(`[Forward API] Request path: ${requestPath}`);
        processedRequestBody.endpoint = requestPath;
    }

    // 3. Apply system prompt from file if configured.
    processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
    await _manageSystemPrompt(processedRequestBody, toProvider);

    // 4. Log the incoming prompt (after potential conversion to the backend's format).
    const promptText = extractPromptText(processedRequestBody, toProvider);

    // 4.1. 应用自定义模型参数 (温度、最大长度等)
    if (customModelConfig) {
        _applyCustomModelParameters(processedRequestBody, customModelConfig, toProvider);
    }

    await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

    // Populate diagnostic trace before dispatch.
    // proxyOverheadMs = time from inbound receipt → first upstream call.
    const _trace = _getTrace(CONFIG);
    if (_trace) {
        _trace.model = model;
        _trace.provider = toProvider;
        _trace.proxyOverheadMs = Date.now() - _trace.startedAt;
        if (isFallbackUsed) {
            // Capture the initial pool-selection fallback (provider/model resolution layer).
            recordFallbackStep(_trace, {
                fromProvider: CONFIG.MODEL_PROVIDER,
                toProvider,
                reason: 'initial-pool-selection-fallback',
                errorCode: null,
                penaltyMs: 0,
                isModelDowngrade: result?.isModelDowngrade === true,
            });
        }
        // Stash request-body thinking flag so the stream handler can consult it.
        _trace._thinkingEnabled = isThinkingEnabled(originalRequestBody) || isThinkingEnabled(processedRequestBody);
    }

    // 5. Call the appropriate stream or unary handler, passing the provider info.
    // 创建重试上下文，包含 CONFIG 以便在认证错误时切换凭证重试
    const credentialSwitchMaxRetries = CONFIG.CREDENTIAL_SWITCH_MAX_RETRIES || 5;
    const retryContext = {
        CONFIG,
        currentRetry: 0,
        maxRetries: credentialSwitchMaxRetries,
        isFallback: isFallbackUsed,
        originalRequestBody: originalRequestBody
    };

    if (isStream) {
        await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
    } else {
        await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
    }

    // 执行插件钩子：内容生成后
    try {
        const pluginManager = getPluginManager();
        await pluginManager.executeHook('onContentGenerated', {
            ...CONFIG,
            originalRequestBody,
            processedRequestBody,
            fromProvider,
            toProvider,
            model,
            isStream
        });
    } catch (e) { /* 静默失败，不影响主流程 */ }
}

export async function _manageSystemPrompt(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    await strategy.manageSystemPrompt(requestBody);
}
