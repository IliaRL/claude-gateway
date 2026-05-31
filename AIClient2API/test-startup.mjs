import { spawn } from 'child_process';

const worker = spawn('node', [
  '-e',
  `
  const origExit = process.exit;
  process.exit = function(code) {
    console.log("=== PROCESS EXIT CALLED WITH CODE " + code + " ===");
    console.log(new Error().stack);
    return origExit.apply(process, arguments);
  };
  
  process.on('uncaughtException', err => {
    console.log("=== UNCAUGHT EXCEPTION ===");
    console.log(err);
  });
  
  import('./src/services/api-server.js').catch(err => {
    console.error("FAILED TO LOAD:", err);
  });
  `
], {
  cwd: '/Users/ilialiston/MASTER-C/AIClient2API',
  env: { ...process.env, MASTER_PID: "123", IS_WORKER: "false" },
  stdio: 'inherit'
});

worker.on('exit', (code, signal) => {
  console.log(`Worker exited with code ${code} and signal ${signal}`);
});
