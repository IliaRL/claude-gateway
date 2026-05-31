import logger from '../utils/logger.js';
import { convertData } from '../convert/convert.js';
import { getPluginManager } from '../core/plugin-manager.js';
import { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from '../utils/constants.js';
import { getCachedResponse, setCachedResponse } from '../services/service-manager.js';
import {
    getProtocolPrefix,
    ENDPOINT_TYPE,
    extractResponseText,
    extractPromptText,
    resolveCustomModelRouting,
    extractSystemPromptFromRequestBody
} from '../utils/model-utils.js';
import {
    ensureValidStatusCode,
    getRequestBody,
    handleUnifiedResponse,
    getRateLimitCooldownRecoveryTime,
    getErrorStatusCode
} from '../utils/network-utils.js';
import { logConversation } from '../utils/logging-utils.js';
import {
    usesManagedModelList,
    getConfiguredSupportedModels,
    getCustomModelConfig,
    getCustomModelActualProvider,
    getCustomModelListProvider
} from '../providers/provider-models.js';
import { ProviderStrategyFactory } from '../utils/provider-strategies.js';

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
    let fullResponseText = '';
    let anyDataSent = retryContext?.anyDataSent || false;
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG;
    const isRetry = currentRetry > 0;
    let clientDisconnected = retryContext?.clientDisconnected || { value: false };
    if (!isRetry) clientDisconnected = { value: false };

    const onClientClose = () => { clientDisconnected.value = true; logger.info('[Stream] Client disconnected'); };
    const onClientError = (err) => { clientDisconnected.value = true; logger.error('[Stream] Response stream error:', err.message); };

    if (!isRetry) {
        res.on('close', onClientClose);
        res.on('error', onClientError);
        const metadata = { actualProvider: toProvider, actualModel: model, isFallback: retryContext?.isFallback, uuid: pooluuid };
        await handleUnifiedResponse(res, '', true, 200, metadata);
    }

    let hasToolCall = false;
    let hasMessageStop = false;

    try {
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
        requestBody.model = model;
        const nativeStream = await service.generateContentStream(model, requestBody);
        const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
        const streamRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

        for await (const nativeChunk of nativeStream) {
            if (clientDisconnected.value) break;
            const chunkText = extractResponseText(nativeChunk, toProvider);
            if (chunkText && !Array.isArray(chunkText)) fullResponseText += chunkText;

            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model, streamRequestId)
                : nativeChunk;

            if (!chunkToSend) continue;
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                if (clientDisconnected.value) break;

                if (chunk.choices?.[0]?.delta?.tool_calls || chunk.choices?.[0]?.finish_reason === 'tool_calls') hasToolCall = true;
                if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') hasToolCall = true;
                if (chunk.type === 'message_delta' && (chunk.delta?.stop_reason === 'tool_use' || chunk.stop_reason === 'tool_use')) hasToolCall = true;
                if (chunk.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) hasToolCall = true;

                if (hasToolCall && needsConversion) {
                    if (chunk.choices?.[0]?.finish_reason === 'stop') chunk.choices[0].finish_reason = 'tool_calls';
                    else if (chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'end_turn') chunk.delta.stop_reason = 'tool_use';
                    else if (chunk.candidates?.[0]?.finishReason === 'STOP' || chunk.candidates?.[0]?.finishReason === 'stop') chunk.candidates[0].finishReason = 'TOOL_CALLS';
                }

                if (chunk?.choices?.some(choice => choice?.finish_reason) || chunk?.type === 'message_stop' || chunk?.type === 'done' || chunk?.candidates?.some(candidate => candidate?.finishReason)) hasMessageStop = true;

                if (addEvent && !clientDisconnected.value && !res.writableEnded) {
                    res.write(`event: ${chunk.type}\n`);
                    anyDataSent = true;
                }

                if (!clientDisconnected.value && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    anyDataSent = true;
                }
            }
        }

        if (providerPoolManager && pooluuid) {
            providerPoolManager.markProviderHealthy(toProvider, { uuid: pooluuid });
        }
    } catch (error) {
        if (clientDisconnected.value) return;
        if (anyDataSent) {
            const errorPayload = createStreamErrorResponse(error, fromProvider);
            if (!res.writableEnded) { res.write(errorPayload); res.end(); }
            return;
        }

        const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
        const statusCode = getErrorStatusCode(error);
        if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
            if (model && typeof providerPoolManager.markModelCooldownForAccount === 'function') {
                // Per-account cooldown for 429 — other accounts of the same provider keep serving this model.
                providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, rateLimitRecoveryTime);
            } else {
                providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, { uuid: pooluuid }, '429 Too Many Requests', rateLimitRecoveryTime);
            }
        } else if (providerPoolManager && pooluuid) {
            const errMsg = (error?.message || '').toLowerCase();
            const isCapacity503 = (statusCode === 503 || statusCode === 502) &&
                (errMsg.includes('no capacity') || errMsg.includes('model') || errMsg.includes('overloaded'));
            if (statusCode === 400 && error.shouldSwitchCredential && error.skipErrorCount) {
                // 400 with switch signal = backend rejection for this model on this account.
                // Apply 60s PER-ACCOUNT cooldown — do NOT block other accounts of this provider.
                if (typeof providerPoolManager.markModelCooldownForAccount === 'function' && model) {
                    providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, 60000);
                }
            } else if (isCapacity503 && model && typeof providerPoolManager.markModelCooldownForAccount === 'function') {
                // 503 "No capacity" is transient and model-specific. Per-account cooldown only.
                providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, 60000);
            } else if (statusCode !== 400 || (statusCode === 400 && !error.skipErrorCount)) {
                providerPoolManager.markProviderUnhealthy(toProvider, { uuid: pooluuid }, error.message);
            }
        }

        if (currentRetry < maxRetries && providerPoolManager && CONFIG) {
            const { getApiServiceWithFallback } = await import('../services/service-manager.js');
            if (retryContext?.triedModels && model) retryContext.triedModels.add(model);
            const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true, triedModels: retryContext?.triedModels });
            if (result) {
                // Ensure the retry context knows this is a fallback so headers can be set
                retryContext.isFallback = true;
            }

            if (result && result.service) {
                const newRetryContext = { ...retryContext, currentRetry: currentRetry + 1, clientDisconnected, anyDataSent, isFallback: true };
                const newToProvider = result.actualProviderType || toProvider;
                let newRequestBody = requestBody;
                
                if (retryContext.originalRequestBody) {
                    newRequestBody = { ...retryContext.originalRequestBody };
                    if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(newToProvider)) {
                        newRequestBody = convertData(newRequestBody, 'request', fromProvider, newToProvider);
                    }
                    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(newToProvider));
                    newRequestBody = await strategy.applySystemPromptFromFile(CONFIG, newRequestBody);
                }

                return await handleStreamRequest(res, result.service, result.actualModel || model, newRequestBody, fromProvider, newToProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, result.uuid, result.serviceConfig?.customName || customName, newRetryContext);
            }
        }

        const errorPayload = createStreamErrorResponse(error, fromProvider);
        if (!res.writableEnded) { res.write(errorPayload); res.end(); }
    } finally {
        if (providerPoolManager && pooluuid) providerPoolManager.releaseSlot(toProvider, pooluuid);
        if (!isRetry) {
            res.off('close', onClientClose); res.off('error', onClientError);
            if (!clientDisconnected.value && !res.writableEnded) {
                const clientProtocol = getProtocolPrefix(fromProvider);
                if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI && !hasMessageStop) res.write('data: [DONE]\n\n');
                else if (clientProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE && !hasMessageStop) { res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); }
                else if (clientProtocol === MODEL_PROTOCOL_PREFIX.GEMINI && !hasMessageStop) res.write('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
                res.end();
            }
            await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        }
    }
}

export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG;

    try {
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
        requestBody.model = model;
        if (requestBody._forceFallbackTesting) {
            const error = new Error("Forced fallback for testing");
            error.status = 502;
            error.shouldSwitchCredential = true;
            error.skipErrorCount = true;
            throw error;
        }
        const nativeResponse = await service.generateContent(model, requestBody);
        const responseText = extractResponseText(nativeResponse, toProvider);
        let clientResponse = needsConversion ? convertData(nativeResponse, 'response', toProvider, fromProvider, model) : nativeResponse;

        const metadata = { actualProvider: toProvider, actualModel: model, isFallback: retryContext?.isFallback, uuid: pooluuid };
        await handleUnifiedResponse(res, JSON.stringify(clientResponse), false, 200, metadata);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        if (providerPoolManager && pooluuid) providerPoolManager.markProviderHealthy(toProvider, { uuid: pooluuid });
    } catch (error) {
        const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
        const statusCode = getErrorStatusCode(error);
        if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
            if (model && typeof providerPoolManager.markModelCooldownForAccount === 'function') {
                providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, rateLimitRecoveryTime);
            } else {
                providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, { uuid: pooluuid }, '429 Too Many Requests', rateLimitRecoveryTime);
            }
        } else if (providerPoolManager && pooluuid) {
            const errMsg = (error?.message || '').toLowerCase();
            const isCapacity503 = (statusCode === 503 || statusCode === 502) &&
                (errMsg.includes('no capacity') || errMsg.includes('model') || errMsg.includes('overloaded'));
            if (statusCode === 400 && error.shouldSwitchCredential && error.skipErrorCount) {
                // 400 with switch signal = backend rejection on this specific account.
                // Apply 60s PER-ACCOUNT cooldown only — keep other accounts available for this model.
                if (typeof providerPoolManager.markModelCooldownForAccount === 'function' && model) {
                    providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, 60000);
                }
            } else if (isCapacity503 && model && typeof providerPoolManager.markModelCooldownForAccount === 'function') {
                // 503 "No capacity" — transient + model-specific. Cool down only THIS model on THIS account.
                providerPoolManager.markModelCooldownForAccount(toProvider, pooluuid, model, 60000);
            } else if (statusCode !== 400 || (statusCode === 400 && !error.skipErrorCount)) {
                providerPoolManager.markProviderUnhealthy(toProvider, { uuid: pooluuid }, error.message);
            }
        }

        if (currentRetry < maxRetries && providerPoolManager && CONFIG) {
            const { getApiServiceWithFallback } = await import('../services/service-manager.js');
            if (retryContext?.triedModels && model) retryContext.triedModels.add(model);
            const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true, triedModels: retryContext?.triedModels });

            if (result && result.service) {
                const newRetryContext = { ...retryContext, currentRetry: currentRetry + 1, isFallback: true };
                const newToProvider = result.actualProviderType || toProvider;
                let newRequestBody = requestBody;

                if (retryContext.originalRequestBody) {
                    newRequestBody = { ...retryContext.originalRequestBody };
                    if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(newToProvider)) {
                        newRequestBody = convertData(newRequestBody, 'request', fromProvider, newToProvider);
                    }
                    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(newToProvider));
                    newRequestBody = await strategy.applySystemPromptFromFile(CONFIG, newRequestBody);
                }

                return await handleUnaryRequest(res, result.service, result.actualModel || model, newRequestBody, fromProvider, newToProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, result.uuid, result.serviceConfig?.customName || customName, newRetryContext);
            }
        }
        const metadata = { actualProvider: toProvider, actualModel: model, isFallback: retryContext?.isFallback, uuid: pooluuid };
        handleError(res, error, toProvider, fromProvider, null, metadata);
    } finally {
        if (providerPoolManager && pooluuid) providerPoolManager.releaseSlot(toProvider, pooluuid);
    }
}

export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid) {
    const clientProviderMap = Object.assign(Object.create(null), { [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI, [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI });
    const fromProvider = Object.hasOwn(clientProviderMap, endpointType) ? clientProviderMap[endpointType] : undefined;
    try {
        const cacheKey = `${endpointType}-${CONFIG.REQUIRED_API_KEY || ''}`;
        const cachedResponse = getCachedResponse(cacheKey);
        if (cachedResponse) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(cachedResponse)); return; }

        let clientModelList;
        const hasMultipleProviders = Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 1;
        if ((CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO || hasMultipleProviders) && providerPoolManager) {
            clientModelList = await providerPoolManager.getAllAvailableModels(endpointType);
        } else {
            const toProvider = CONFIG.MODEL_PROVIDER;
            const configuredSupportedModels = getConfiguredSupportedModels(toProvider, CONFIG);
            if (usesManagedModelList(toProvider) && configuredSupportedModels.length > 0) {
                clientModelList = buildConfiguredModelListResponse(configuredSupportedModels, toProvider, endpointType);
            } else {
                let resolvedService = service || await (async () => { const { getApiService } = await import('../services/service-manager.js'); return await getApiService(CONFIG, null, { skipUsageCount: true }); })();
                const nativeModelList = await resolvedService.listModels();
                clientModelList = getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider)) ? nativeModelList : convertData(nativeModelList, 'modelList', toProvider, fromProvider);
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(clientModelList));
        setCachedResponse(cacheKey, clientModelList);
    } catch (error) { handleError(res, error, CONFIG.MODEL_PROVIDER, fromProvider); }
}

export function buildConfiguredModelListResponse(models, providerType, listEndpointType) {
    if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
        const now = new Date();
        return {
            object: 'list',
            data: models.map(id => ({
                id,
                object: 'model',
                type: 'model',
                display_name: id,
                owned_by: providerType,
                created: Math.floor(now.getTime() / 1000),
                created_at: now.toISOString()
            }))
        };
    }
    return { models: models.map(id => ({ name: `models/${id}`, baseModelId: id, version: 'v1', displayName: id, supportedGenerationMethods: ['generateContent', 'countTokens'] })) };
}

export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, requestPath = null) {
    let fromProvider;
    try {
        const originalRequestBody = await getRequestBody(req);
        if (req.headers['x-force-fallback'] === 'true') {
            originalRequestBody._forceFallbackTesting = true;
        }
        const endpointMap = Object.assign(Object.create(null), { [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI, [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE, [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI });
        fromProvider = Object.hasOwn(endpointMap, endpointType) ? endpointMap[endpointType] : undefined;
        let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
        let { model, isStream } = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider)).extractModelAndStreamInfo(req, originalRequestBody);
        const originalModel = model;

        const shouldSelectByPool = providerPoolManager && (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO || (CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]));
        let isFallback = false;
        if (!service || shouldSelectByPool) {
            const { getApiServiceWithFallback } = await import('../services/service-manager.js');
            const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: shouldSelectByPool });
            service = result.service;
            toProvider = result.actualProviderType;
            model = result.actualModel || model;
            isFallback = result.isFallback === undefined ? false : result.isFallback;
        }

        let processedRequestBody = { ...originalRequestBody };
        if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)) processedRequestBody = convertData(processedRequestBody, 'request', fromProvider, toProvider);

        const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(toProvider));
        await strategy.manageSystemPrompt(processedRequestBody);
        processedRequestBody = await strategy.applySystemPromptFromFile(CONFIG, processedRequestBody);

        const retryContext = { CONFIG, currentRetry: 0, maxRetries: CONFIG.CREDENTIAL_SWITCH_MAX_RETRIES || 5, triedModels: new Set([model]), isFallback, originalRequestBody, originalModel };
        if (isStream) await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, CONFIG.customName, retryContext);
        else await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, CONFIG.customName, retryContext);
    } catch (error) {
        handleError(res, error, null, fromProvider || MODEL_PROTOCOL_PREFIX.OPENAI, req);
    }
}

export function handleError(res, error, provider = null, fromProvider = null, req = null, metadata = {}) {
    const statusCode = ensureValidStatusCode(error.response?.status || error.statusCode || error.status || error.code || 500);
    const errorResponse = createErrorResponse(error, fromProvider || MODEL_PROTOCOL_PREFIX.OPENAI);
    if (!res.headersSent) {
        const headers = { 'Content-Type': 'application/json' };
        if (metadata.isFallback) headers['X-Proxy-Fallback-Used'] = 'true';
        if (metadata.actualProvider) headers['X-Proxy-Actual-Provider'] = metadata.actualProvider;
        if (metadata.actualModel) headers['X-Proxy-Actual-Model'] = metadata.actualModel;
        if (error.retryAfter != null) headers['Retry-After'] = String(error.retryAfter);
        res.writeHead(statusCode, headers);
    }
    res.end(JSON.stringify(errorResponse));
}

function createErrorResponse(error, fromProvider) {
    const protocol = getProtocolPrefix(fromProvider);
    const message = error.message || "An error occurred.";
    const code = error.status || error.code || 500;
    if (protocol === MODEL_PROTOCOL_PREFIX.CLAUDE) return { type: "error", error: { type: "server_error", message } };
    if (protocol === MODEL_PROTOCOL_PREFIX.GEMINI) return { error: { code, message, status: "INTERNAL" } };
    return { error: { message, type: "server_error", code: "server_error" } };
}

function createStreamErrorResponse(error, fromProvider) {
    const err = createErrorResponse(error, fromProvider);
    if (getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI) return `data: ${JSON.stringify(err)}\n\n`;
    return `event: error\ndata: ${JSON.stringify(err)}\n\n`;
}
