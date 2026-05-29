import './src/converters/register-converters.js';
import { convertData } from './src/convert/convert.js';
const claudeReq = {
    model: "claude-3-sonnet",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    system: "You are an AI.",
    tools: [{
        name: "BashTool",
        description: "Run a bash command",
        input_schema: {
            type: "object",
            properties: {
                command: { type: "string" },
                messages: { type: "array", items: { type: "object" } }
            },
            required: ["command"]
        }
    }]
};
const geminiReq = convertData(claudeReq, 'request', 'claude-kiro-oauth', 'gemini-antigravity');
console.log(JSON.stringify(geminiReq, null, 2));
