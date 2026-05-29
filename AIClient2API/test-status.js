import { ProviderPoolManager } from './src/providers/provider-pool-manager.js';

class DummyLogger {
  constructor() {}
  info(msg) {}
  warn(msg) {}
  error(msg) {}
  debug(msg) {}
}

const mgr = new ProviderPoolManager({ CRON_NEAR_MINUTES: 10 }, new DummyLogger());
mgr.initialize();
setTimeout(() => {
  const pools = mgr.getPoolsStatus();
  const ag = pools.find(p => p.provider === 'gemini-antigravity');
  console.log(JSON.stringify(ag, null, 2));
  process.exit(0);
}, 1000);
