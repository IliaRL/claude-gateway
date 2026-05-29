import { PoolManager } from './src/providers/provider-pool-manager.js';
import fs from 'fs';

class DummyLogger {
  constructor() {}
  info(msg) { console.log('[INFO]', msg); }
  warn(msg) { console.log('[WARN]', msg); }
  error(msg) { console.log('[ERR]', msg); }
  debug(msg) { console.log('[DBG]', msg); }
}

const mgr = new PoolManager({ CRON_NEAR_MINUTES: 10 }, new DummyLogger());
mgr.initialize();
setTimeout(() => {
  const p = mgr.selectProvider('gemini-antigravity', 'gemini-claude-sonnet-4-6');
  console.log('Selected provider:', p ? p.config.displayName : 'NULL');
}, 1000);
