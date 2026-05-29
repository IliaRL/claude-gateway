const fetch = require('node-fetch');

async function main() {
    const tools = [{
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
    }];

    const res = await fetch('http://127.0.0.1:3000/antigravity/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'Authorization': 'Bearer test'
        },
        body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "Test" }],
            max_tokens: 10,
            tools: tools
        })
    });
    console.log(res.status);
    console.log(await res.text());
}
main();
