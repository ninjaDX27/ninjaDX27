import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { Logger } from "pino";
import { WebSocketServer, type WebSocket } from "ws";
import type { StreamFactory } from "./agent.js";
import { HttpAvailabilityProvider, StaticAvailabilityProvider } from "./availability.js";
import type { AppConfig } from "./config.js";
import type { Crypto } from "./crypto.js";
import type { Store, Tenant } from "./db/store.js";
import { DbReservationSink, type WebhookOptions } from "./reservations.js";
import type { Resort } from "./resort.js";
import { CallSession } from "./session.js";
import { SessionTokens, fallbackTwiml, hangupTwiml, isValidTwilioSignature, relayTwiml, unavailableTwiml } from "./twilio.js";
import { randomBytes } from "node:crypto";
import { mountWeb } from "./web/routes.js";

export interface AppDeps {
  config: AppConfig;
  store: Store;
  crypto: Crypto;
  stream: StreamFactory;
  /** Perfil de exemplo usado ao criar um novo cliente. */
  resortTemplate: Resort;
  log: Logger;
  webhookOpts?: WebhookOptions;
  publicDir?: string;
}

const CALL_SID = /^CA[0-9a-f]{32}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const RELAY_PATH = /^\/relay\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const TEST_RELAY_PATH = /^\/relay-test\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export function createApp(deps: AppDeps): { server: Server; shutdown: () => Promise<void>; activeCalls: () => number } {
  const { config, log, store } = deps;
  const tokens = new SessionTokens(config.SESSION_SIGNING_SECRET);
  const sessions = new Map<WebSocket, string>(); // ws -> tenantId
  const wsBase = config.PUBLIC_BASE_URL.replace(/^http/, "ws");
  /** Origens dos browsers que podem usar o painel (o URL público e, na versão PC, o localhost). */
  const allowedOrigins = new Set([new URL(config.PUBLIC_BASE_URL).origin, ...config.EXTRA_ORIGINS]);
  const activeFor = (tenantId: string) => [...sessions.values()].filter((t) => t === tenantId).length;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'self'"],
          styleSrcAttr: ["'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          connectSrc: ["'self'"],
          mediaSrc: ["'self'"],
          // Em localhost (versão PC) não se força HTTPS.
          upgradeInsecureRequests: config.DESKTOP_MODE ? null : [],
        },
      },
      strictTransportSecurity: !config.DESKTOP_MODE,
      referrerPolicy: { policy: "same-origin" },
    }),
  );
  // Microfone só para a chamada de teste, e só nesta origem.
  app.use((_req, res, next) => {
    res.set("permissions-policy", "microphone=(self), camera=(), geolocation=(), payment=()");
    next();
  });
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));

  const twilioForm = express.urlencoded({ extended: false, limit: "20kb", parameterLimit: 100 });

  /** Rejeita pedidos que não venham assinados pelo Twilio. */
  const requireTwilio = (req: Request, res: Response, next: NextFunction) => {
    if (!config.TWILIO_AUTH_TOKEN) return res.status(503).type("text/plain").send("Twilio not configured");
    if (!config.TWILIO_VALIDATE_SIGNATURE) return next();
    const ok = isValidTwilioSignature(
      config.TWILIO_AUTH_TOKEN,
      req.header("x-twilio-signature"),
      `${config.PUBLIC_BASE_URL}${req.originalUrl}`,
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
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  app.get("/healthz", async (_req, res) => {
    try {
      await store.ping();
      res.set("cache-control", "no-store").json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  // Webhook "A call comes in" de todos os números: o cliente é identificado pelo número marcado.
  app.post("/voice", twilioForm, requireTwilio, async (req, res) => {
    const callSid = str(req.body?.CallSid);
    const to = str(req.body?.To);
    if (!CALL_SID.test(callSid) || !E164.test(to)) return res.status(400).type("text/plain").send("Bad Request");

    const tenant = await store.tenantByNumber(to);
    if (!tenant || tenant.status !== "active") {
      log.warn({ call: callSid }, "chamada para número sem cliente ativo");
      return sendTwiml(res, unavailableTwiml());
    }
    const callLog = log.child({ call: callSid, tenant: tenant.id });
    const lang = tenant.profile.languages[0]!.code;

    const { minutes } = await store.monthStats(tenant.id);
    const overLimit =
      minutes >= tenant.monthly_minutes_limit ||
      activeFor(tenant.id) >= tenant.max_concurrent_calls ||
      sessions.size >= config.MAX_CONCURRENT_CALLS;
    if (overLimit) {
      callLog.warn("limite do plano ou de capacidade: a encaminhar para a receção");
      return sendTwiml(res, fallbackTwiml(tenant.reception_phone, lang, true));
    }

    await store.startCall(tenant.id, callSid, deps.crypto.pseudonymize(str(req.body?.From)));
    callLog.info("chamada recebida");
    sendTwiml(
      res,
      relayTwiml({
        resort: tenant.profile,
        wsUrl: `${wsBase}/relay/${tokens.issue(callSid, tenant.id)}`,
        actionUrl: `${config.PUBLIC_BASE_URL}/handoff`,
      }),
    );
  });

  // "action" do <Connect>: chamado quando a sessão do ConversationRelay termina.
  app.post("/handoff", twilioForm, requireTwilio, async (req, res) => {
    const to = str(req.body?.To);
    const tenant = E164.test(to) ? await store.tenantByNumber(to) : null;
    let data: { action?: unknown; language?: unknown } = {};
    const raw = str(req.body?.HandoffData);
    if (raw && raw.length < 2000) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }
    }
    const lang = typeof data.language === "string" ? data.language : (tenant?.profile.languages[0]!.code ?? "pt-PT");
    if (data.action === "end") return sendTwiml(res, hangupTwiml(lang));
    // Transferência pedida, ou sessão terminada por erro: nunca abandonar o cliente.
    return sendTwiml(res, fallbackTwiml(tenant?.reception_phone ?? null, lang, data.action !== "transfer"));
  });

  mountWeb(app, deps, {
    allowedOrigins,
    /** Emite um token para a chamada de teste no browser (só o dono autenticado chega aqui). */
    issueTestCall: async (tenant: Tenant) => {
      if (sessions.size >= config.MAX_CONCURRENT_CALLS || activeFor(tenant.id) >= tenant.max_concurrent_calls) return null;
      const callSid = `CA${randomBytes(16).toString("hex")}`;
      await store.startCall(tenant.id, callSid, "teste-no-browser");
      return { callSid, path: `/relay-test/${tokens.issue(callSid, tenant.id)}` };
    },
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

  const startSession = (ws: WebSocket, tenant: Tenant, callSid: string) => {
    sessions.set(ws, tenant.id);
    const callLog = log.child({ call: callSid, tenant: tenant.id });
    const startedAt = Date.now();

    let count = 0;
    const window = setInterval(() => (count = 0), 1000);
    ws.on("message", () => {
      if (++count > 50) ws.close(1008, "rate limit");
    });
    let alive = true;
    ws.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);

    const availability =
      tenant.pms_url && tenant.pms_token_enc
        ? new HttpAvailabilityProvider(tenant.profile, tenant.pms_url, deps.crypto.decrypt(tenant.pms_token_enc))
        : new StaticAvailabilityProvider(tenant.profile);

    new CallSession(ws, {
      agentOptions: {
        resort: tenant.profile,
        model: config.CLAUDE_MODEL,
        effort: config.CLAUDE_EFFORT,
        refusalFallback: config.CLAUDE_REFUSAL_FALLBACK,
        timeoutMs: config.LLM_TIMEOUT_MS,
        stream: deps.stream,
        log: callLog,
      },
      availability,
      reservations: new DbReservationSink(store, deps.crypto, tenant, callLog, deps.webhookOpts),
      expectedCallSid: callSid,
      maxTurns: config.MAX_TURNS_PER_CALL,
      maxUtteranceChars: config.MAX_UTTERANCE_CHARS,
      maxCallDurationMs: config.MAX_CALL_DURATION_SECONDS * 1000,
      log: callLog,
      onClose: (stats) => {
        sessions.delete(ws);
        clearInterval(window);
        clearInterval(heartbeat);
        store
          .endCall(callSid, { ...stats, duration_s: Math.round((Date.now() - startedAt) / 1000) })
          .catch((err: unknown) => callLog.error({ err: err instanceof Error ? err.message : "?" }, "falha ao registar chamada"));
      },
    });
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const testMatch = TEST_RELAY_PATH.exec(path);
    const match = RELAY_PATH.exec(path) ?? testMatch;
    if (!match) return reject(socket, 404, "Not Found");

    if (testMatch) {
      // Chamada de teste no browser: tem de vir da nossa origem (impede sequestro de WebSocket entre sites).
      // O token só é emitido a um dono autenticado, com CSRF, e é de uso único.
      if (!allowedOrigins.has(String(req.headers.origin ?? ""))) return reject(socket, 403, "Forbidden");
    } else if (!config.TWILIO_AUTH_TOKEN) {
      return reject(socket, 403, "Forbidden");
    } else if (config.TWILIO_VALIDATE_SIGNATURE) {
      const header = req.headers["x-twilio-signature"];
      const sig = Array.isArray(header) ? header[0] : header;
      // O URL assinado deriva sempre de PUBLIC_BASE_URL, nunca do cabeçalho Host.
      const ok =
        isValidTwilioSignature(config.TWILIO_AUTH_TOKEN, sig, `${wsBase}${req.url ?? ""}`, {}) ||
        isValidTwilioSignature(config.TWILIO_AUTH_TOKEN, sig, `${config.PUBLIC_BASE_URL}${req.url ?? ""}`, {});
      if (!ok) {
        log.warn("upgrade websocket com assinatura inválida");
        return reject(socket, 403, "Forbidden");
      }
    }
    const claim = tokens.consume(match[1]!);
    if (!claim) return reject(socket, 403, "Forbidden");
    if (sessions.size >= config.MAX_CONCURRENT_CALLS) return reject(socket, 503, "Service Unavailable");

    store
      .tenantById(claim.tenantId)
      .then((tenant) => {
        if (!tenant || tenant.status !== "active") return reject(socket, 403, "Forbidden");
        wss.handleUpgrade(req, socket, head, (ws) => startSession(ws, tenant, claim.callSid));
      })
      .catch(() => reject(socket, 503, "Service Unavailable"));
  });

  const shutdown = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    for (const ws of sessions.keys()) ws.close(1001, "server shutting down");
    wss.close();
  };

  return { server, shutdown, activeCalls: () => sessions.size };
}
