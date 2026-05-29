const http = require('http');

const tools = [
    {
        name: "BashTool",
        description: "Run a bash command",
        input_schema: {
            type: "object",
            properties: {
                command: { type: "string" },
            },
            required: ["command"]
        }
    }
];

const req = http.request({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/v1/messages',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-a60f3efdf9b97e63c84ab4a3583f9d1c'
    }
}, (res) => {
    let data = '';
    console.log(res.statusCode);
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => { console.log(data); });
});

req.write(JSON.stringify({
    model: "gemini-antigravity:gemini-3.1-pro-low",
    messages: [{ role: "user", content: "Test" }],
    max_tokens: 10,
    tools: tools
}));
req.end();
