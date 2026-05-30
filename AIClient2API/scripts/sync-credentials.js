import fs from 'fs';
import path from 'path';
import url from 'url';

// Define target path
const TARGET_DIR = '/Users/ilialiston/MASTER-C/Credentials';
const PROJECT_DIR = process.env.SYNC_PROJECT_DIR || '/Users/ilialiston/MASTER-C/AIClient2API';

export async function syncCredentials(options = {}) {
    const dryRun = options.dryRun || false;
    const verbose = options.verbose ?? true;

    const log = (level, message) => {
        if (verbose) {
            console.log(`[CredentialsSync] [${level.toUpperCase()}] ${message}`);
        }
    };

    log('info', `Starting credential sync... Target: ${TARGET_DIR} (Dry run: ${dryRun})`);

    // Load configs
    const configPath = path.normalize(path.join(PROJECT_DIR, 'configs', 'config.json'));
    const poolsPath = path.normalize(path.join(PROJECT_DIR, 'configs', 'provider_pools.json'));

    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    if (!fs.existsSync(poolsPath)) {
        throw new Error(`Pools file not found: ${poolsPath}`);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const pools = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));

    // Master API Key
    const requiredApiKey = config.REQUIRED_API_KEY || '';

    // Simple API Keys from pool arrays
    const getApiKey = (providerType) => {
        const pool = Object.hasOwn(pools, providerType) ? pools[providerType] : [];
        const item = pool[0];
        return item?.OPENAI_API_KEY || '';
    };

    const nvidiaKey = getApiKey('nvidia-nim');
    const githubKey = getApiKey('github-models');
    const openrouterKey = getApiKey('openai-custom');

    // Helper to resolve and read JSON credential files
    const readCredFile = (relPath) => {
        try {
            const absPath = path.normalize(path.resolve(PROJECT_DIR, relPath));
            if (!absPath.startsWith(path.normalize(PROJECT_DIR))) {
                throw new Error('Path traversal detected');
            }
            if (fs.existsSync(absPath)) {
                return JSON.parse(fs.readFileSync(absPath, 'utf8'));
            }
        } catch (e) {
            log('warn', `Failed to read credential file ${relPath}: ${e.message}`);
        }
        return null;
    };

    // Pre-resolve OAuth credential objects
    const resolvedOAuth = {
        'claude-kiro-oauth': [],
        'openai-codex-oauth': [],
        'gemini-cli-oauth': [],
        'gemini-antigravity': []
    };

    // 1. Claude Kiro OAuth
    const kiroPool = pools['claude-kiro-oauth'] || [];
    for (const item of kiroPool) {
        if (item.KIRO_OAUTH_CREDS_FILE_PATH) {
            const credData = readCredFile(item.KIRO_OAUTH_CREDS_FILE_PATH);
            if (credData) {
                resolvedOAuth['claude-kiro-oauth'].push({
                    customName: item.customName,
                    data: credData
                });
            }
        }
    }

    // 2. OpenAI Codex OAuth
    const codexPool = pools['openai-codex-oauth'] || [];
    for (const item of codexPool) {
        if (item.CODEX_OAUTH_CREDS_FILE_PATH) {
            const credData = readCredFile(item.CODEX_OAUTH_CREDS_FILE_PATH);
            if (credData) {
                resolvedOAuth['openai-codex-oauth'].push({
                    customName: item.customName,
                    data: credData
                });
            }
        }
    }

    // 3. Gemini CLI OAuth
    const geminiCliPool = pools['gemini-cli-oauth'] || [];
    for (const item of geminiCliPool) {
        if (item.GEMINI_OAUTH_CREDS_FILE_PATH) {
            const credData = readCredFile(item.GEMINI_OAUTH_CREDS_FILE_PATH);
            if (credData) {
                resolvedOAuth['gemini-cli-oauth'].push({
                    customName: item.customName,
                    data: credData
                });
            }
        }
    }

    // 4. Gemini Antigravity
    const antigravityPool = pools['gemini-antigravity'] || [];
    for (const item of antigravityPool) {
        if (item.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH) {
            const credData = readCredFile(item.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH);
            if (credData) {
                resolvedOAuth['gemini-antigravity'].push({
                    customName: item.customName,
                    data: credData
                });
            }
        }
    }

    // Write out the new directory structure
    let updateCount = 0;

    const writeFileIfChanged = (filePath, newContent) => {
        let oldContent = '';
        if (fs.existsSync(filePath)) {
            oldContent = fs.readFileSync(filePath, 'utf8');
        }
        if (oldContent !== newContent) {
            if (!dryRun) {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(filePath, newContent, 'utf8');
            }
            updateCount++;
            log('info', `Synced ${filePath}`);
        }
    };

    // 1. System Master Keys
    if (requiredApiKey) {
        writeFileIfChanged(path.join(TARGET_DIR, 'System', 'REQUIRED_API_KEY.txt'), requiredApiKey);
    }

    // 2. Simple API Keys
    if (nvidiaKey) {
        writeFileIfChanged(path.join(TARGET_DIR, 'nvidia-nim', 'NVIDIA_NIM_API_Key.txt'), nvidiaKey);
    }
    if (githubKey) {
        writeFileIfChanged(path.join(TARGET_DIR, 'github-models', 'GitHub_PAT_API_Key.txt'), githubKey);
    }
    if (openrouterKey) {
        writeFileIfChanged(path.join(TARGET_DIR, 'openai-custom', 'Open_router_API_Key.txt'), openrouterKey);
    }

    // 3. OAuth JSONs
    for (const [providerName, accounts] of Object.entries(resolvedOAuth)) {
        for (let idx = 0; idx < accounts.length; idx++) {
            const acc = accounts[idx];
            // Format custom name for filename
            let safeName = acc.customName ? acc.customName.replace(/[^a-zA-Z0-9@.\-_]/g, '_') : `account_${idx + 1}`;
            const filePath = path.join(TARGET_DIR, providerName, `${safeName}.json`);
            const content = JSON.stringify(acc.data, null, 2);
            writeFileIfChanged(filePath, content);
        }
    }

    if (updateCount === 0) {
        log('info', 'No credentials changed; Master Credentials directory is already up to date.');
        return false;
    }

    if (!dryRun) {
        log('info', `Successfully synced ${updateCount} credential(s) to ${TARGET_DIR}`);
    } else {
        log('info', `[DRY-RUN] Would have written ${updateCount} updated credential(s) to ${TARGET_DIR}`);
    }

    return true;
}

// Support CLI execution directly
const isMain = import.meta.url === url.pathToFileURL(process.argv[1]).href;
if (isMain) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run') || args.includes('-d');
    
    syncCredentials({ dryRun })
        .then((updated) => {
            process.exit(0);
        })
        .catch(err => {
            console.error(`[CredentialsSync] [ERROR] Sync failed:`, err.message);
            process.exit(1);
        });
}
