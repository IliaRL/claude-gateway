import { initApiService, getApiServiceWithFallback } from './src/services/service-manager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function test() {
    const configPath = path.normalize(path.join(__dirname, 'configs', 'config.json'));
    const poolsPath = path.normalize(path.join(__dirname, 'configs', 'provider_pools.json'));
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.providerPools = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
    config.MODEL_PROVIDER = 'claude-kiro-oauth';
    
    await initApiService(config);
    
    const modelsToTest = [
        'claude-haiku-4-5',
        'claude-sonnet-4-6'
    ];
    
    for (const model of modelsToTest) {
        console.log(`\nTesting model: ${model}`);
        try {
            const result = await getApiServiceWithFallback(config, model);
            console.log(Object.keys(result.apiService));
            if (result.apiService.adapter) {
               console.log("Has adapter");
               console.log(Object.keys(result.apiService.adapter));
               const requestBody = {
                   messages: [{ role: 'user', content: 'Hi' }],
                   model: model,
                   max_tokens: 1
               };
               await result.apiService.adapter.handleUnaryRequest(null, result.apiService, model, requestBody, null, null);
            }
        } catch (error) {
            console.error(`Failed! Error: ${error.message}`);
        }
    }
    
    process.exit(0);
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
