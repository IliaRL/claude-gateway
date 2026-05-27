const fs = require('fs');
let code = fs.readFileSync('src/providers/claude/claude-kiro.js', 'utf8');
code = code.replace(
    /const response = await this\.callApi\('', finalModel, requestBody\);/,
    "const error = new Error('Mock 400 Kiro Error'); error.response = { status: 400 }; throw error;\n        const response = await this.callApi('', finalModel, requestBody);"
);
fs.writeFileSync('src/providers/claude/claude-kiro.js', code);
