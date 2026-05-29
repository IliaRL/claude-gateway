import http from 'http';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_PORT = 8085;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const SCOPES = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email';

const filesToFix = [
    "application_default_credentials.json",
    "application_default_credentials copy.json",
    "application_default_credentials copy 3.json",
    "application_default_credentials copy 5.json",
    "application_default_credentials copy 6.json",
    "application_default_credentials copy 7.json",
    "application_default_credentials copy 9.json",
    "application_default_credentials copy 10.json",
    "application_default_credentials copy 11.json",
    "application_default_credentials copy 12.json"
];

const CONFIG_DIR = path.join(__dirname, '../configs/gemini');

async function getTokens(code) {
    return new Promise((resolve, reject) => {
        const data = new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code'
        }).toString();

        const options = {
            hostname: 'oauth2.googleapis.com',
            port: 443,
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': data.length
            }
        };

        const req = https.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(body));
                } else {
                    reject(new Error(`Failed to get token: ${body}`));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function processFile(filename) {
    return new Promise((resolve, reject) => {
        console.log(`\n======================================================`);
        console.log(`🚀 Preparing to authenticate for: ${filename}`);
        console.log(`======================================================`);
        
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            response_type: 'code',
            scope: SCOPES,
            access_type: 'offline',
            prompt: 'consent select_account'
        });
        
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
        
        const server = http.createServer(async (req, res) => {
            try {
                // Ignore favicon requests
                if (req.url === '/favicon.ico') {
                    res.writeHead(204);
                    return res.end();
                }

                const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
                const code = url.searchParams.get('code');
                
                if (code) {
                    res.setHeader('Connection', 'close'); // Force browser to drop connection
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`
                        <div style="font-family: sans-serif; padding: 40px; text-align: center;">
                            <h1 style="color: #4CAF50;">✅ Success!</h1>
                            <p>Credentials saved for <b>${filename}</b>.</p>
                            <p>You can close this tab and return to the terminal.</p>
                            <script>setTimeout(()=>window.close(), 2000)</script>
                        </div>
                    `);
                    
                    console.log(`⏳ Received callback, exchanging code for tokens...`);
                    const tokens = await getTokens(code);
                    
                    if (!tokens.refresh_token) {
                        console.error('❌ Error: Google did not return a refresh_token. You may need to revoke access to the app first, or ensure prompt=consent is used.');
                    } else {
                        const creds = {
                            access_token: tokens.access_token,
                            scope: "https://www.googleapis.com/auth/cloud-platform",
                            token_type: "Bearer",
                            expiry_date: Date.now() + (tokens.expires_in * 1000),
                            refresh_token: tokens.refresh_token
                        };
                        
                        const filePath = path.join(CONFIG_DIR, filename);
                        fs.writeFileSync(filePath, JSON.stringify(creds, null, 2));
                        console.log(`✅ Saved credentials to ${filename}`);
                    }
                    
                    req.socket.destroy(); // Forcefully close the socket
                    server.close(); // Stop listening
                    resolve(); // Immediately move to the next file
                    
                } else {
                    const error = url.searchParams.get('error');
                    if (error) {
                        res.setHeader('Connection', 'close');
                        res.writeHead(400);
                        res.end(`Auth failed: ${error}`);
                        console.error(`❌ Authentication failed: ${error}`);
                        req.socket.destroy();
                        server.close();
                        reject(new Error(`Auth failed: ${error}`));
                    } else {
                        res.writeHead(400);
                        res.end('No code found');
                    }
                }
            } catch (err) {
                console.error('Error during callback:', err.message);
                res.setHeader('Connection', 'close');
                res.writeHead(500);
                res.end('Internal Server Error');
                req.socket.destroy();
                server.close();
                reject(err);
            }
        });

        server.listen(REDIRECT_PORT, () => {
            console.log(`\n🌐 Opening browser for authentication...`);
            
            // Open browser
            let command;
            switch (process.platform) {
                case 'darwin': command = `open "${authUrl}"`; break;
                case 'win32': command = `start "" "${authUrl}"`; break;
                default: command = `xdg-open "${authUrl}"`; break;
            }
            exec(command);
        });
        
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`❌ Port ${REDIRECT_PORT} is in use. Please stop the proxy temporarily so we can catch the redirect.`);
            }
            reject(err);
        });
    });
}

async function main() {
    console.log("Running in parallel with proxy. Listening on port 8085 for Google callback...");
    
    for (const file of filesToFix) {
        try {
            await processFile(file);
            console.log(`Waiting 3 seconds before next file...`);
            await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
            console.error(`Failed on ${file}:`, err.message);
            console.log("Aborting.");
            process.exit(1);
        }
    }
    console.log(`\n🎉 All files processed successfully! You can tell Gemini to continue with the next steps.`);
    process.exit(0);
}

main();
