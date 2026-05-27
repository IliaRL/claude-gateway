import { KiroApiService } from './src/providers/claude/claude-kiro.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function test() {
    const poolsPath = new URL('./configs/provider_pools.json', import.meta.url);
    const providerPools = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
    const kiroAccount = providerPools['claude-kiro-oauth'][0];
    const kiroService = new KiroApiService(kiroAccount, { PROXY_URL: null }, null);
    
    await kiroService.initialize();

    const t = { model: 'claude-sonnet-4.5' };
    console.log(`\nTesting model passing to Kiro: "${t.model}"`);
    try {
        const reqBody = {
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 10
        };
        const response = await kiroService.generateContent(t.model, reqBody);
        console.log("SUCCESS! Response:", JSON.stringify(response, null, 2));
    } catch (error) {
        console.error(`Failed! Error: ${error.message}`);
        if (error.response?.data) {
            console.error("Response body:", JSON.stringify(error.response.data));
        } else if (error.message.includes('400')) {
            console.error("Probably a 400 Bad Request");
        }
    }
    process.exit(0);
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
