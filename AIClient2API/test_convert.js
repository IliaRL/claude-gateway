import './src/converters/register-converters.js';
import { convertData } from './src/convert/convert.js';
const claudeReq = {
    model: "claude-3-sonnet",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    system: "You are an AI."
};
const geminiReq = convertData(claudeReq, 'request', 'claude-kiro-oauth', 'gemini-antigravity');
console.log(JSON.stringify(geminiReq, null, 2));
