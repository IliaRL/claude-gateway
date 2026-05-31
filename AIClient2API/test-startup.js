const fs = require('fs');
const cp = require('child_process');

console.log("Starting api-server.js with tracing...");

const worker = cp.spawn('node', ['src/services/api-server.js'], {
    env: { ...process.env, TRACE_EXIT: "1" },
    cwd: '/Users/ilialiston/MASTER-C/AIClient2API',
    stdio: 'inherit'
});

worker.on('exit', (code, signal) => {
    console.log(`Worker exited with code ${code} and signal ${signal}`);
});
