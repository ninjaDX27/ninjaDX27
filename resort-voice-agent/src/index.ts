import Anthropic from "@anthropic-ai/sdk";
import { anthropicStreamFactory } from "./agent.js";
import { HttpAvailabilityProvider, StaticAvailabilityProvider, type AvailabilityProvider } from "./availability.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { LogOnlyReservationSink, WebhookReservationSink, type ReservationSink } from "./reservations.js";
import { loadResort } from "./resort.js";
import { createApp } from "./server.js";

function main(): void {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const resort = loadResort(config.RESORT_CONFIG_PATH);

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 1, timeout: config.LLM_TIMEOUT_MS });

  const availability: AvailabilityProvider =
    config.AVAILABILITY_PROVIDER === "http"
      ? new HttpAvailabilityProvider(resort, config.PMS_API_URL!, config.PMS_API_TOKEN!)
      : new StaticAvailabilityProvider(resort);

  let reservations: ReservationSink;
  if (config.RESERVATION_WEBHOOK_URL && config.RESERVATION_WEBHOOK_SECRET) {
    reservations = new WebhookReservationSink(config.RESERVATION_WEBHOOK_URL, config.RESERVATION_WEBHOOK_SECRET, log);
  } else {
    log.warn("RESERVATION_WEBHOOK_URL não definido: os pedidos de reserva NÃO serão entregues a ninguém");
    reservations = new LogOnlyReservationSink(log);
  }

  const { server, shutdown } = createApp({
    config,
    resort,
    stream: anthropicStreamFactory(client),
    availability,
    reservations,
    log,
  });

  server.listen(config.PORT, () => {
    log.info(
      { port: config.PORT, resort: resort.name, model: config.CLAUDE_MODEL, availability: config.AVAILABILITY_PROVIDER },
      "agente de voz pronto",
    );
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "a encerrar");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason instanceof Error ? reason.message : String(reason) }, "unhandledRejection");
  });
}

try {
  main();
} catch (err) {
  // Erros de configuração: mensagem clara e saída com código != 0.
  console.error((err as Error).message);
  process.exit(1);
}
