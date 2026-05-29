import { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';
import {
    getCustomModelConfig,
    getCustomModelActualProvider,
    getCustomModelListProvider,
} from '../providers/provider-models.js';
import { ProviderStrategyFactory } from './provider-strategies.js';

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai_chat',
    OPENAI_RESPONSES: 'openai_responses',
    GEMINI_CONTENT: 'gemini_content',
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
    GEMINI_MODEL_LIST: 'gemini_model_list',
};

/**
 * Extracts the protocol prefix from a given model provider string.
 */
export function getProtocolPrefix(provider) {
    if (provider === MODEL_PROVIDER.CODEX_API) return MODEL_PROTOCOL_PREFIX.CODEX;
    if (provider === MODEL_PROVIDER.NVIDIA_NIM || provider.startsWith(MODEL_PROVIDER.NVIDIA_NIM + '-')) return MODEL_PROTOCOL_PREFIX.OPENAI;
    if (provider === MODEL_PROVIDER.GITHUB_MODELS || provider.startsWith(MODEL_PROVIDER.GITHUB_MODELS + '-')) return MODEL_PROTOCOL_PREFIX.OPENAI;
    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) return provider.substring(0, hyphenIndex);
    return provider;
}

export function resolveCustomModelRouting(model, currentProvider, customModelConfig = getCustomModelConfig(model, currentProvider)) {
    if (!customModelConfig) {
        return { isCustomModel: false, model, provider: currentProvider, actualModel: model, actualProvider: currentProvider, config: null };
    }
    const customActualProvider = getCustomModelActualProvider(customModelConfig);
    const customActualModel = customModelConfig.actualModel || customModelConfig.id || model;
    return {
        isCustomModel: true,
        model: customActualModel,
        provider: customActualProvider || currentProvider,
        actualModel: customActualModel,
        actualProvider: customActualProvider || currentProvider,
        config: customModelConfig
    };
}

export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            const openaiSystemMessage = requestBody.messages?.find(m => m.role === 'system' || m.role === 'developer');
            if (openaiSystemMessage?.content) {
                incomingSystemText = openaiSystemMessage.content;
            }
            if (typeof incomingSystemText === 'object' && incomingSystemText !== null) {
                if (Array.isArray(incomingSystemText)) {
                    incomingSystemText = incomingSystemText
                        .map(item => (typeof item === 'string' ? item : item.text || JSON.stringify(item)))
                        .join('\n');
                } else {
                    incomingSystemText = JSON.stringify(incomingSystemText);
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
            if (geminiSystemInstruction?.parts) {
                incomingSystemText = geminiSystemInstruction.parts
                    .filter(p => p?.text)
                    .map(p => p.text)
                    .join('\n');
            }
            break;
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            }
            break;
    }
    return incomingSystemText;
}

export function extractResponseText(response, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractPromptText(requestBody);
}
