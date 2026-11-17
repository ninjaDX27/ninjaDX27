import Anthropic from "@anthropic-ai/sdk";
import { anthropicStreamFactory } from "./agent.js";
import { loadConfig } from "./config.js";
import { Crypto, hashPassword, temporaryPassword } from "./crypto.js";
import { PgDb } from "./db/driver.js";
import { Store } from "./db/store.js";
import { createLogger } from "./logger.js";
import { loadResort } from "./resort.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const crypto = new Crypto(config.MASTER_ENCRYPTION_KEY);
  const resortTemplate = loadResort("config/resort.example.json");

  const store = new Store(new PgDb(config.DATABASE_URL!, config.DATABASE_SSL));
  await store.migrate();

  // Primeiro arranque: cria a conta de administrador da plataforma.
  if (!(await store.adminExists())) {
    const password = config.ADMIN_INITIAL_PASSWORD ?? temporaryPassword();
    await store.ensureAdmin(config.ADMIN_EMAIL.toLowerCase(), await hashPassword(password));
    if (config.ADMIN_INITIAL_PASSWORD) {
      log.info({ email: config.ADMIN_EMAIL }, "conta de administrador criada com ADMIN_INITIAL_PASSWORD (alteração obrigatória no primeiro acesso)");
    } else {
      // Mostrada uma única vez, fora do logger estruturado. Tem de ser alterada no primeiro acesso.
      console.log(`\n=== Conta de administrador criada ===\nE-mail: ${config.ADMIN_EMAIL}\nPalavra-passe temporária: ${password}\n=====================================\n`);
    }
  }

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 1, timeout: config.LLM_TIMEOUT_MS });
  const { server, shutdown } = createApp({ config, store, crypto, stream: anthropicStreamFactory(client), resortTemplate, log });

  // RGPD: limpeza diária dos dados pessoais fora do prazo de retenção.
  const purge = () =>
    store
      .purge(config.RETENTION_DAYS)
      .then((n) => n > 0 && log.info({ anonymized: n }, "retenção aplicada"))
      .catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : "?" }, "falha na limpeza de retenção"));
  void purge();
  const purgeTimer = setInterval(purge, 24 * 3600_000);
  purgeTimer.unref();

  server.listen(config.PORT, () => log.info({ port: config.PORT, brand: config.BRAND_NAME, model: config.CLAUDE_MODEL }, "serviço pronto"));

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "a encerrar");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    shutdown()
      .then(() => store.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason instanceof Error ? reason.message : String(reason) }, "unhandledRejection");
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
