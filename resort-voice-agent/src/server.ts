import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { Logger } from "pino";
import { WebSocketServer, type WebSocket } from "ws";
import type { StreamFactory } from "./agent.js";
import type { AvailabilityProvider } from "./availability.js";
import type { AppConfig } from "./config.js";
import { pseudonymize } from "./logger.js";
import type { ReservationSink } from "./reservations.js";
import type { Resort } from "./resort.js";
import { CallSession } from "./session.js";
import {
  SessionTokens,
  dialReceptionTwiml,
  hangupTwiml,
  isValidTwilioSignature,
  relayTwiml,
} from "./twilio.js";

export interface AppDeps {
  config: AppConfig;
  resort: Resort;
  stream: StreamFactory;
  availability: AvailabilityProvider;
  reservations: ReservationSink;
  log: Logger;
}

const CALL_SID = /^CA[0-9a-f]{32}$/;
const RELAY_PATH = /^\/relay\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export function createApp(deps: AppDeps): { server: Server; shutdown: () => Promise<void>; activeCalls: () => number } {
  const { config, log } = deps;
  const tokens = new SessionTokens(config.SESSION_SIGNING_SECRET);
  const sessions = new Set<WebSocket>();
  const wsBase = config.PUBLIC_BASE_URL.replace(/^https:/, "wss:");
  const primaryLang = deps.resort.languages[0]!.code;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );

  const twilioForm = express.urlencoded({ extended: false, limit: "20kb", parameterLimit: 100 });

  /** Rejeita pedidos que não venham assinados pelo Twilio. */
  const requireTwilio = (req: Request, res: Response, next: NextFunction) => {
    if (!config.TWILIO_VALIDATE_SIGNATURE) return next();
    const url = `${config.PUBLIC_BASE_URL}${req.originalUrl}`;
    const ok = isValidTwilioSignature(
      config.TWILIO_AUTH_TOKEN,
      req.header("x-twilio-signature"),
      url,
      (req.body ?? {}) as Record<string, unknown>,
    );
    if (!ok) {
      log.warn({ path: req.path, ip: req.ip }, "assinatura Twilio inválida");
      return res.status(403).type("text/plain").send("Forbidden");
    }
    next();
  };

  const sendTwiml = (res: Response, xml: string) => {
    res.status(200).type("text/xml").set("cache-control", "no-store").send(xml);
  };

  app.get("/healthz", (_req, res) => {
    res.set("cache-control", "no-store").json({ status: "ok" });
  });

  // Webhook "A call comes in" do número Twilio.
  app.post("/voice", twilioForm, requireTwilio, (req, res) => {
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    if (!CALL_SID.test(callSid)) return res.status(400).type("text/plain").send("Bad Request");
    const callLog = log.child({ call: callSid, caller: pseudonymize(req.body?.From) });

    if (sessions.size >= config.MAX_CONCURRENT_CALLS) {
      callLog.warn("capacidade máxima: a encaminhar para a receção");
      return sendTwiml(res, dialReceptionTwiml(config.RECEPTION_PHONE_NUMBER, primaryLang, true));
    }
    const token = tokens.issue(callSid);
    callLog.info("chamada recebida");
    sendTwiml(
      res,
      relayTwiml({
        resort: deps.resort,
        wsUrl: `${wsBase}/relay/${token}`,
        actionUrl: `${config.PUBLIC_BASE_URL}/handoff`,
      }),
    );
  });

  // "action" do <Connect>: chamado quando a sessão do ConversationRelay termina.
  app.post("/handoff", twilioForm, requireTwilio, (req, res) => {
    let data: { action?: unknown; language?: unknown } = {};
    if (typeof req.body?.HandoffData === "string" && req.body.HandoffData.length < 2000) {
      try {
        data = JSON.parse(req.body.HandoffData);
      } catch {
        data = {};
      }
    }
    const lang = typeof data.language === "string" ? data.language : primaryLang;
    if (data.action === "transfer") {
      return sendTwiml(res, dialReceptionTwiml(config.RECEPTION_PHONE_NUMBER, lang));
    }
    if (data.action === "end") return sendTwiml(res, hangupTwiml(lang));
    // Sessão terminou sem pedido explícito (erro/queda da ligação): não abandonar o cliente.
    return sendTwiml(res, dialReceptionTwiml(config.RECEPTION_PHONE_NUMBER, lang, true));
  });

  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not Found");
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) return res.status(status).type("text/plain").send("Bad Request");
    log.error({ err: err instanceof Error ? err.message : "?" }, "erro não tratado");
    res.status(500).type("text/plain").send("Internal Server Error");
  });

  const server = createServer(app);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  const reject = (socket: Duplex, code: number, text: string) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const match = RELAY_PATH.exec(path);
    if (!match) return reject(socket, 404, "Not Found");

    if (config.TWILIO_VALIDATE_SIGNATURE) {
      const header = req.headers["x-twilio-signature"];
      const sig = Array.isArray(header) ? header[0] : header;
      // O URL assinado é o nosso próprio URL público (wss://, ou https:// consoante a
      // versão do Twilio). Ambos derivam de PUBLIC_BASE_URL, não do cabeçalho Host.
      const ok =
        isValidTwilioSignature(config.TWILIO_AUTH_TOKEN, sig, `${wsBase}${req.url ?? ""}`, {}) ||
        isValidTwilioSignature(config.TWILIO_AUTH_TOKEN, sig, `${config.PUBLIC_BASE_URL}${req.url ?? ""}`, {});
      if (!ok) {
        log.warn("upgrade websocket com assinatura inválida");
        return reject(socket, 403, "Forbidden");
      }
    }
    const callSid = tokens.consume(match[1]!);
    if (!callSid) return reject(socket, 403, "Forbidden");
    if (sessions.size >= config.MAX_CONCURRENT_CALLS) return reject(socket, 503, "Service Unavailable");

    wss.handleUpgrade(req, socket, head, (ws) => {
      sessions.add(ws);
      const callLog = log.child({ call: callSid });

      // Limite de mensagens por segundo por ligação.
      let count = 0;
      const window = setInterval(() => (count = 0), 1000);
      ws.on("message", () => {
        if (++count > 50) ws.close(1008, "rate limit");
      });

      // Heartbeat: termina ligações mortas.
      let alive = true;
      ws.on("pong", () => (alive = true));
      const heartbeat = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 30_000);

      new CallSession(ws, {
        agentOptions: {
          resort: deps.resort,
          model: config.CLAUDE_MODEL,
          effort: config.CLAUDE_EFFORT,
          refusalFallback: config.CLAUDE_REFUSAL_FALLBACK,
          timeoutMs: config.LLM_TIMEOUT_MS,
          stream: deps.stream,
          log: callLog,
        },
        availability: deps.availability,
        reservations: deps.reservations,
        expectedCallSid: callSid,
        maxTurns: config.MAX_TURNS_PER_CALL,
        maxUtteranceChars: config.MAX_UTTERANCE_CHARS,
        maxCallDurationMs: config.MAX_CALL_DURATION_SECONDS * 1000,
        log: callLog,
        onClose: () => {
          sessions.delete(ws);
          clearInterval(window);
          clearInterval(heartbeat);
        },
      });
    });
  });

  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const ws of sessions) ws.close(1001, "server shutting down");
    wss.close();
  };

  return { server, shutdown, activeCalls: () => sessions.size };
}
