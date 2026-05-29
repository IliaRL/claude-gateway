export class CooldownManager {
    constructor(defaultDurationMs) {
        this._cooldowns = new Map();
        this._defaultDurationMs = defaultDurationMs || 300000;
    }

    mark(providerType, model, durationMs, log) {
        if (!providerType || !model) return;
        const expiry = Date.now() + (durationMs || this._defaultDurationMs);
        if (!this._cooldowns.has(providerType)) {
            this._cooldowns.set(providerType, new Map());
        }
        this._cooldowns.get(providerType).set(model, expiry);
        if (log) log('warn', `[Model Cooldown] ${providerType} :: ${model} cooled down until ${new Date(expiry).toISOString()}`);
    }

    isOnCooldown(providerType, model) {
        if (!providerType || !model) return false;
        const typeMap = this._cooldowns.get(providerType);
        if (!typeMap) return false;
        const expiry = typeMap.get(model);
        if (!expiry) return false;
        if (Date.now() >= expiry) {
            typeMap.delete(model);
            if (typeMap.size === 0) this._cooldowns.delete(providerType);
            return false;
        }
        return true;
    }

    clear(providerType, model) {
        const typeMap = this._cooldowns.get(providerType);
        if (!typeMap) return;
        if (model) typeMap.delete(model);
        else typeMap.clear();
        if (typeMap.size === 0) this._cooldowns.delete(providerType);
    }
}
