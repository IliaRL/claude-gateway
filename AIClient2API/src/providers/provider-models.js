import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { convertData } from '../convert/convert.js';
import { MODEL_PROVIDER } from '../utils/common.js';
import { CONFIG } from '../core/config-manager.js';

const _require = createRequire(import.meta.url);
const _catalogPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../configs/model-catalog.json');
const _catalog = JSON.parse(_require('fs').readFileSync(_catalogPath, 'utf8'));

const _byProvider = {};
for (const entry of _catalog) {
    if (!_byProvider[entry.provider]) _byProvider[entry.provider] = [];
    _byProvider[entry.provider].push(entry.id);
}
// Seed managed-list providers that have no static models in the catalog
// (their model lists come from live API calls at runtime).
for (const p of ['claude-custom', 'openai-custom', 'openaiResponses-custom', 'forward-api']) {
    if (!_byProvider[p]) _byProvider[p] = [];
}

/**
 * 获取模型配置元数据
 * @param {string} modelId - 模型 ID 或别名
 * @param {string|null} provider - 自定义模型归属的提供商
 * @returns {Object|null} 模型配置
 */
export function getCustomModelConfig(modelId, provider = null) {
    if (!CONFIG.customModels || !Array.isArray(CONFIG.customModels)) {
        return null;
    }

    let targetProvider = provider && provider !== MODEL_PROVIDER.AUTO ? provider : null;
    let targetModelId = modelId;

    // Only treat "prefix:rest" as provider:model when prefix has no slash
    // (provider names are simple tokens; model IDs like "openai/gpt-oss-20b:free" must not be split)
    if (typeof modelId === 'string' && modelId.includes(':')) {
        const [prefix, ...modelParts] = modelId.split(':');
        if (!prefix.includes('/')) {
            targetProvider = prefix;
            targetModelId = modelParts.join(':');
        }
    }

    if (!targetProvider) {
        return CONFIG.customModels.find(m =>
            !m.provider &&
            (m.id === targetModelId || m.alias === targetModelId)
        ) || null;
    }

    return CONFIG.customModels.find(m =>
        m.provider === targetProvider &&
        (m.id === targetModelId || m.alias === targetModelId)
    ) || null;
}

/**
 * 各提供商支持的模型列表
 * 用于前端UI选择不支持的模型
 * Loaded from configs/model-catalog.json — do not hardcode model IDs here.
 */
export const PROVIDER_MODELS = Object.assign(Object.create(null), _byProvider);

export const MANAGED_MODEL_LIST_PROVIDERS = [
    'openai-custom',
    'openaiResponses-custom',
    'claude-custom'
];

export function getManagedModelListProviderType(providerType) {
    return MANAGED_MODEL_LIST_PROVIDERS.find(baseType =>
        providerType === baseType || providerType.startsWith(baseType + '-')
    ) || null;
}

export function usesManagedModelList(providerType) {
    return getManagedModelListProviderType(providerType) !== null;
}

export function normalizeModelIds(models = []) {
    return [...new Set(
        (Array.isArray(models) ? models : [])
            .filter(model => typeof model === 'string')
            .map(model => model.trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
}

export function getCustomModelActualProvider(modelConfig) {
    if (!modelConfig) {
        return '';
    }
    if (Object.prototype.hasOwnProperty.call(modelConfig, 'actualProvider')) {
        return modelConfig.actualProvider || '';
    }
    return modelConfig.provider || '';
}

export function getCustomModelListProvider(modelConfig) {
    return modelConfig?.provider || getCustomModelActualProvider(modelConfig);
}

export function customModelMatchesProvider(modelConfig, providerType) {
    const listProvider = getCustomModelListProvider(modelConfig);
    return listProvider === providerType || (listProvider && providerType.startsWith(listProvider + '-'));
}

function extractModelIdsFromListShape(modelList) {
    if (!modelList) {
        return [];
    }

    if (Array.isArray(modelList)) {
        return modelList.map(item => {
            if (typeof item === 'string') return item;
            return item?.id || item?.name || item?.model || null;
        }).filter(Boolean);
    }

    if (Array.isArray(modelList.data)) {
        return modelList.data.map(item => item?.id || item?.name || item?.model || null).filter(Boolean);
    }

    if (Array.isArray(modelList.models)) {
        return modelList.models.map(item => {
            if (typeof item === 'string') return item;
            return item?.id || item?.name || item?.model || null;
        }).filter(Boolean);
    }

    return [];
}

export function extractModelIdsFromNativeList(modelList, providerType) {
    let convertedModelList = modelList;

    // 只有在提供商类型与目标类型协议不同时才尝试转换
    if (providerType !== MODEL_PROVIDER.OPENAI_CUSTOM && !providerType.startsWith(MODEL_PROVIDER.OPENAI_CUSTOM + '-')) {
        try {
            convertedModelList = convertData(modelList, 'modelList', providerType, MODEL_PROVIDER.OPENAI_CUSTOM);
        } catch {
            convertedModelList = modelList;
        }
    }

    const convertedIds = normalizeModelIds(extractModelIdsFromListShape(convertedModelList));
    if (convertedIds.length > 0) {
        return convertedIds;
    }

    return normalizeModelIds(extractModelIdsFromListShape(modelList));
}

export function getConfiguredSupportedModels(providerType, providerConfig = {}) {
    if (!usesManagedModelList(providerType)) {
        return [];
    }

    const models = normalizeModelIds(providerConfig?.supportedModels);
    return models.slice(0, 15);
}

/**
 * 获取指定提供商类型支持的模型列表
 * @param {string} providerType - 提供商类型
 * @returns {Array<string>} 模型列表
 */
export function getProviderModels(providerType) {
    let models = [];
    if (PROVIDER_MODELS[providerType]) {
        models = [...PROVIDER_MODELS[providerType]];
    } else {
        // 尝试前缀匹配 (例如 openai-custom-1 -> openai-custom)
        for (const key of Object.keys(PROVIDER_MODELS)) {
            if (providerType.startsWith(key + '-')) {
                models = [...PROVIDER_MODELS[key]];
                break;
            }
        }
    }

    // 注入自定义模型
    if (CONFIG.customModels && Array.isArray(CONFIG.customModels)) {
        CONFIG.customModels.forEach(m => {
            // 匹配模型列表归属提供商或其后缀分组
            if (customModelMatchesProvider(m, providerType)) {
                // 注入 ID
                if (!models.includes(m.id)) {
                    models.push(m.id);
                }
            }
        });
    }

    return normalizeModelIds(models);
}

/**
 * 获取所有提供商的模型列表
 * @returns {Object} 所有提供商的模型映射
 */
export function getAllProviderModels() {
    // 执行深拷贝，避免修改原始 PROVIDER_MODELS 对象
    const allModels = Object.create(null);
    for (const provider in PROVIDER_MODELS) {
        if (Object.hasOwn(PROVIDER_MODELS, provider)) {
            allModels[provider] = [...PROVIDER_MODELS[provider]];
        }
    }
    
    // 合并自定义模型到对应的提供商
    if (CONFIG.customModels && Array.isArray(CONFIG.customModels)) {
        CONFIG.customModels.forEach(m => {
            // 如果指定了模型列表归属提供商，注入到该提供商
            // 如果没有指定（Auto），则注入到特殊的虚拟分组
            const targetProvider = getCustomModelListProvider(m) || 'custom-auto';
            
            if (!allModels[targetProvider]) {
                allModels[targetProvider] = [];
            }
            
            // 注入 ID
            if (!allModels[targetProvider].includes(m.id)) {
                allModels[targetProvider].push(m.id);
            }
        });
    }
    
    // 对每个列表进行排序
    for (const provider in allModels) {
        allModels[provider] = normalizeModelIds(allModels[provider]);
    }
    
    return allModels;
}
