import axios from 'axios';
import logger from '../../utils/logger.js';
import * as http from 'http';
import * as https from 'https';
import { configureAxiosProxy, configureTLSSidecar, isTLSSidecarEnabledForProvider } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER, getRetryAfterMs } from '../../utils/common.js';
import { sharedHttpAgent, sharedHttpsAgent } from '../../utils/network-utils.js';

// Assumed OpenAI API specification service for interacting with third-party models
export class OpenAIApiService {
    constructor(config) {
        if (!config.OPENAI_API_KEY) {
            throw new Error("OpenAI API Key is required for OpenAIApiService.");
        }
        this.config = config;
        this.apiKey = config.OPENAI_API_KEY;
        this.baseUrl = config.OPENAI_BASE_URL;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_OPENAI ?? false;
        logger.info(`[OpenAI] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'User-Agent': 'AIClient2API/3.0.6 (GitHub Models Support)'
        };

        // OpenRouter requires HTTP-Referer (and optionally X-Title) to accept requests,
        // especially for free-tier models. Without these, requests can be rejected
        // with 400/402 even when the API key is valid.
        if (typeof this.baseUrl === 'string' && this.baseUrl.includes('openrouter.ai')) {
            headers['HTTP-Referer'] = config.OPENROUTER_HTTP_REFERER || 'https://github.com/justlovemaki/AIClient2API';
            headers['X-Title'] = config.OPENROUTER_X_TITLE || 'AIClient2API';
        }

        const axiosConfig = {
            baseURL: this.baseUrl,
            headers,
            timeout: 90000,
            // Reuse a single keep-alive agent across all openai-custom / NIM /
            // GitHub Models / OpenRouter instances. Saves the TCP+TLS handshake
            // (~150–300 ms) on warm requests.
            httpAgent: sharedHttpAgent,
            httpsAgent: sharedHttpsAgent,
        };

        this.axiosInstance = axios.create(axiosConfig);
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.OPENAI_CUSTOM, this.baseUrl);
    }

    /**
     * In-place strip verbose `description` fields from OpenAI-format tool schemas.
     * Keeps tool name + parameter shape so function calling still works, but
     * removes the natural-language descriptions that bloat the payload by
     * thousands of bytes per tool. Safe for small-context Azure endpoints.
     */
    _compactToolSchemas(body) {
        if (!Array.isArray(body.tools)) return;
        for (const tool of body.tools) {
            const fn = tool && tool.function;
            if (!fn) continue;
            if (typeof fn.description === 'string' && fn.description.length > 64) {
                fn.description = fn.description.slice(0, 64);
            }
            const props = fn.parameters && fn.parameters.properties;
            if (props && typeof props === 'object') {
                for (const key of Object.keys(props)) {
                    const p = props[key];
                    if (p && typeof p.description === 'string' && p.description.length > 48) {
                        p.description = p.description.slice(0, 48);
                    }
                }
            }
        }
    }

    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        // GitHub Models (Azure AI Inference) enforces tight per-model input-token caps
        // (e.g. gpt-4o-mini ≈ 8K input). Claude Code's full tool schema can dwarf this
        // and Azure responds with an opaque "Request too large (max 32MB)" 413.
        // Pre-flight: when targeting the Azure inference endpoint, strip tool/function
        // description fields to compact the schema and surface a clean error if the
        // remaining payload still looks oversized.
        const isAzureGithubModels =
            typeof this.baseUrl === 'string' &&
            this.baseUrl.includes('models.inference.ai.azure.com');
        if (isAzureGithubModels && body && typeof body === 'object') {
            try {
                this._compactToolSchemas(body);
                const approxBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
                // GitHub Models free tier caps at ~8K input tokens regardless of model context window.
                // ~4 chars/token ⇒ 8K ≈ 32KB. Cap at 30KB so synthetic 413 fires before the round-trip.
                const SOFT_LIMIT = 30 * 1024;
                if (approxBytes > SOFT_LIMIT) {
                    const err = new Error(
                        `GitHub Models input too large after schema compaction: ${approxBytes} bytes ` +
                        `exceeds soft limit ${SOFT_LIMIT}. Tool schema + system prompt likely exceeds ` +
                        `the model's input-token cap. Select a higher-context provider (nvidia-nim / kiro / antigravity).`
                    );
                    err.response = { status: 413, data: { error: { message: err.message, code: 413 } } };
                    throw err;
                }
            } catch (compactErr) {
                if (compactErr.response?.status === 413) throw compactErr;
                logger.warn(`[OpenAI API] github-models pre-flight compaction failed (non-fatal): ${compactErr.message}`);
            }
        }

        try {
            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: body
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            if (status === 401 || status === 403) {
                logger.error(`[OpenAI API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[OpenAI API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[OpenAI API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[OpenAI API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[OpenAI API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`[OpenAI API] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        // OpenAI 的流式请求需要将 stream 设置为 true
        const streamRequestBody = { ...body, stream: true };

        try {
            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: streamRequestBody,
                responseType: 'stream'
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);

            const stream = response.data;
            let buffer = '';

            for await (const chunk of stream) {
                buffer += chunk.toString();
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const jsonData = line.substring(6).trim();
                        if (jsonData === '[DONE]') {
                            return; // Stream finished
                        }
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            yield parsedChunk;
                        } catch (e) {
                            logger.warn("[OpenAIApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
                        }
                    } else if (line === '') {
                        // Empty line, end of an event
                    }
                }
            }
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            if (status === 401 || status === 403) {
                logger.error(`[OpenAI API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[OpenAI API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[OpenAI API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[OpenAI API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[OpenAI API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`[OpenAI API] Error calling streaming API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async generateContent(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        return this.callApi('/chat/completions', requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        yield* this.streamApi('/chat/completions', requestBody);
    }

    async listModels() {
        try {
            const response = await this.axiosInstance.get('/models');
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            logger.error(`Error listing OpenAI models (Status: ${status}):`, data || error.message);
            throw error;
        }
    }
}

