import { buildApp } from "./app.js";
import { loadConfig } from "./lib/config/index.js";
import { createKv } from "./lib/kv/index.js";
import { createFactoryHistory } from "./lib/factoryHistory/index.js";
import { initCrypto } from "./lib/crypto/index.js";
import { startPrReviewer } from "./lib/prReviewer/index.js";

async function main(): Promise<void> {
  await initCrypto();
  const config = loadConfig(process.env);
  const kv = await createKv(config);
  const factoryHistory = await createFactoryHistory(config);
  // Optional: runs only with a database plus LLM and GitHub App credentials;
  // otherwise it logs one line, every /v1/pr-reviewer route answers 503, and
  // the rest of the server is exactly as before.
  const reviewer = startPrReviewer(process.env);
  const app = buildApp({
    kv,
    config,
    factoryHistory,
    prReviewer: reviewer && {
      sequelize: reviewer.sequelize,
      github: reviewer.github,
      wake: () => reviewer.runner.wake(),
    },
  });
  app.listen(config.port, () => {
    console.log(`marge-web listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(
    "startup_failed",
    err instanceof Error ? err.message : "unknown",
  );
  process.exit(1);
});
