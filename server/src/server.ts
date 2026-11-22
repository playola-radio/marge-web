import { buildApp } from './app.js';
import { loadConfig } from './lib/config/index.js';
import { createKv } from './lib/kv/index.js';
import { createFactoryHistory } from './lib/factoryHistory/index.js';
import { initCrypto } from './lib/crypto/index.js';

async function main(): Promise<void> {
  await initCrypto();
  const config = loadConfig(process.env);
  const kv = await createKv(config);
  const factoryHistory = await createFactoryHistory(config);
  const app = buildApp({ kv, config, factoryHistory });
  app.listen(config.port, () => {
    console.log(`marge-web listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error('startup_failed', err instanceof Error ? err.message : 'unknown');
  process.exit(1);
});
