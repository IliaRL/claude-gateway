const fs = require('fs');
let code = fs.readFileSync('src/handlers/api-handlers.js', 'utf8');
code = code.replace(
    /const nativeResponse = await service\.generateContent\(model, requestBody\);/,
    "console.log('[DEBUG-REQUEST-BODY] TO-PROVIDER:', toProvider, 'BODY:', JSON.stringify(requestBody).substring(0, 500));\n        const nativeResponse = await service.generateContent(model, requestBody);"
);
fs.writeFileSync('src/handlers/api-handlers.js', code);
