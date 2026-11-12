import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import { WebSocket } from "ws";
import { StaticAvailabilityProvider } from "../src/availability.js";
import type { ReservationSink } from "../src/reservations.js";
import { createApp } from "../src/server.js";
import { TEST_ENV, daysFromNow, scriptedStream, silentLog, testConfig, testResort, type ScriptedReply } from "./helpers.js";

const BASE = TEST_ENV.PUBLIC_BASE_URL;
const TOKEN = TEST_ENV.TWILIO_AUTH_TOKEN;
const CALL_SID = "CA" + "1".repeat(32);

type App = ReturnType<typeof createApp>;
let current: App | null = null;

afterEach(async () => {
  await current?.shutdown();
  current = null;
});

async function start(replies: ScriptedReply[], overrides: Record<string, string> = {}) {
  const resort = testResort();
  const stream = scriptedStream(replies);
  const reservations: ReservationSink = { submit: vi.fn(async () => ({ request_id: "12345678-aaaa" })) };
  const app = createApp({
    config: testConfig(overrides),
    resort,
    stream,
    availability: new StaticAvailabilityProvider(resort),
    reservations,
    log: silentLog,
  });
  current = app;
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const port = (app.server.address() as AddressInfo).port;
  return { port, stream, reservations, app };
}

function sign(url: string, params: Record<string, string>) {
  return twilio.getExpectedTwilioSignature(TOKEN, url, params);
}

async function postForm(port: number, path: string, params: Record<string, string>, signature?: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(signature !== undefined ? { "x-twilio-signature": signature } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
}

async function incomingCall(port: number) {
  const params = { CallSid: CALL_SID, From: "+351910000000", To: "+351210000001", AccountSid: "AC" + "0".repeat(32) };
  const res = await postForm(port, "/voice", params, sign(`${BASE}/voice`, params));
  const xml = await res.text();
  return { res, xml };
}

function wsPathFrom(xml: string): string {
  const m = /url="wss:\/\/voice\.example\.test(\/relay\/[^"]+)"/.exec(xml);
  if (!m) throw new Error("sem url do relay na TwiML: " + xml);
  return m[1]!;
}

function connect(port: number, path: string, signature?: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: signature ? { "x-twilio-signature": signature } : {},
    });
    const inbox: any[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    ws.on("open", () => resolve({ ws, inbox }));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout à espera da condição");
}

describe("HTTP", () => {
  it("healthz responde sem expor informação", async () => {
    const { port } = await start([]);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-powered-by")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("/voice rejeita pedidos sem assinatura ou com assinatura errada", async () => {
    const { port } = await start([]);
    const params = { CallSid: CALL_SID };
    expect((await postForm(port, "/voice", params)).status).toBe(403);
    expect((await postForm(port, "/voice", params, "AAAA")).status).toBe(403);
    // Assinatura válida mas para outros parâmetros (adulteração)
    expect((await postForm(port, "/voice", { CallSid: CALL_SID, From: "+1" }, sign(`${BASE}/voice`, params))).status).toBe(403);
  });

  it("/voice devolve TwiML ConversationRelay com idiomas e handoff", async () => {
    const { port } = await start([]);
    const { res, xml } = await incomingCall(port);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(xml).toContain("<ConversationRelay");
    expect(xml).toContain('language="pt-PT"');
    expect(xml).toContain('<Language code="en-GB"');
    expect(xml).toContain(`action="${BASE}/handoff"`);
    expect(xml).toContain("inteligência artificial");
  });

  it("/voice rejeita CallSid inválido", async () => {
    const { port } = await start([]);
    const params = { CallSid: "../../etc" };
    expect((await postForm(port, "/voice", params, sign(`${BASE}/voice`, params))).status).toBe(400);
  });

  it("/handoff transfere para a receção ou desliga", async () => {
    const { port } = await start([]);
    const transfer = { CallSid: CALL_SID, HandoffData: JSON.stringify({ action: "transfer", language: "pt-PT" }) };
    const t = await (await postForm(port, "/handoff", transfer, sign(`${BASE}/handoff`, transfer))).text();
    expect(t).toContain("<Dial");
    expect(t).toContain("+351210000000");
    const end = { CallSid: CALL_SID, HandoffData: JSON.stringify({ action: "end", language: "en-GB" }) };
    const e = await (await postForm(port, "/handoff", end, sign(`${BASE}/handoff`, end))).text();
    expect(e).toContain("<Hangup/>");
    expect(e).not.toContain("<Dial");
    const broken = { CallSid: CALL_SID, HandoffData: "{nope" };
    const b = await (await postForm(port, "/handoff", broken, sign(`${BASE}/handoff`, broken))).text();
    expect(b).toContain("<Dial"); // nunca abandonar o cliente
  });

  it("acima da capacidade encaminha para a receção", async () => {
    const { port } = await start([], { MAX_CONCURRENT_CALLS: "1" });
    const first = await incomingCall(port);
    const path = wsPathFrom(first.xml);
    const { ws } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    const second = await incomingCall(port);
    expect(second.xml).toContain("<Dial");
    expect(second.xml).not.toContain("ConversationRelay");
    ws.close();
  });
});

describe("WebSocket ConversationRelay", () => {
  it("rejeita upgrade sem assinatura, com token inválido ou reutilizado", async () => {
    const { port } = await start([]);
    const { xml } = await incomingCall(port);
    const path = wsPathFrom(xml);
    await expect(connect(port, path)).rejects.toThrow(/403/);
    await expect(connect(port, "/relay/abc.def", sign(`wss://voice.example.test/relay/abc.def`, {}))).rejects.toThrow(/403/);
    await expect(connect(port, "/outro", sign(`wss://voice.example.test/outro`, {}))).rejects.toThrow(/404/);
    const { ws } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    ws.close();
    await expect(connect(port, path, sign(`wss://voice.example.test${path}`, {}))).rejects.toThrow(/403/);
  });

  it("fecha a sessão se o CallSid do setup não corresponder", async () => {
    const { port } = await start([]);
    const path = wsPathFrom((await incomingCall(port)).xml);
    const { ws } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.send(JSON.stringify({ type: "setup", callSid: "CA" + "9".repeat(32) }));
    expect(await closed).toBe(1008);
  });

  it("conversa completa: disponibilidade -> resposta falada em streaming", async () => {
    const ci = daysFromNow(20);
    const co = daysFromNow(23);
    const { port, stream } = await start([
      {
        blocks: [
          { type: "text", text: "Vou verificar." },
          { type: "tool_use", id: "tu_1", name: "check_availability", input: { check_in: ci, check_out: co, adults: 2 } },
        ],
      },
      { blocks: [{ type: "text", text: "Temos o **quarto** vista mar por 480 euros." }] },
    ]);
    const path = wsPathFrom((await incomingCall(port)).xml);
    const { ws, inbox } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    ws.send(JSON.stringify({ type: "setup", callSid: CALL_SID, from: "+351910000000" }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Quero um quarto para dois", last: true }));

    await waitFor(() => inbox.find((m) => m.type === "text" && m.last === true));
    const spoken = inbox.filter((m) => m.type === "text").map((m) => m.token).join("");
    expect(spoken).toContain("Vou verificar.");
    expect(spoken).toContain("Temos o quarto vista mar");
    expect(spoken).not.toContain("**");

    // 2ª ronda recebeu o resultado da ferramenta; parâmetros do modelo corretos
    const second = stream.calls[1]!;
    const last = second.messages[second.messages.length - 1]!;
    expect(Array.isArray(last.content) && (last.content[0] as any).type).toBe("tool_result");
    expect(JSON.parse((last.content as any)[0].content).offers.length).toBeGreaterThan(0);
    expect(second.model).toBe("claude-opus-5-5");
    expect(second.fallbacks).toBe("default");
    expect(second.output_config?.effort).toBe("low");
    ws.close();
  });

  it("transfer_to_human envia 'end' com handoffData", async () => {
    const { port } = await start([
      {
        blocks: [
          { type: "text", text: "Vou transferi-lo para a receção." },
          { type: "tool_use", id: "tu_1", name: "transfer_to_human", input: { reason: "pedido do cliente" } },
        ],
      },
    ]);
    const path = wsPathFrom((await incomingCall(port)).xml);
    const { ws, inbox } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    ws.send(JSON.stringify({ type: "setup", callSid: CALL_SID }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Quero falar com uma pessoa", last: true }));
    const end = await waitFor(() => inbox.find((m) => m.type === "end"));
    expect(JSON.parse(end.handoffData)).toMatchObject({ action: "transfer", language: "pt-PT" });
    ws.close();
  });

  it("switch_language envia mensagem 'language' ao Twilio", async () => {
    const { port } = await start([
      { blocks: [{ type: "tool_use", id: "tu_1", name: "switch_language", input: { language_code: "en-GB" } }] },
      { blocks: [{ type: "text", text: "Of course, how can I help?" }] },
    ]);
    const path = wsPathFrom((await incomingCall(port)).xml);
    const { ws, inbox } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    ws.send(JSON.stringify({ type: "setup", callSid: CALL_SID }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Do you speak English?", last: true }));
    await waitFor(() => inbox.find((m) => m.type === "text" && m.last === true));
    expect(inbox.find((m) => m.type === "language")).toEqual({
      type: "language",
      ttsLanguage: "en-GB",
      transcriptionLanguage: "en-GB",
    });
    ws.close();
  });

  it("interrupção aborta a resposta em curso e a fala seguinte é processada", async () => {
    const { port, stream } = await start([
      { blocks: [{ type: "text", text: "Resposta lenta que vai ser interrompida" }], delayMs: 300 },
      { blocks: [{ type: "text", text: "Claro, diga." }] },
    ]);
    const path = wsPathFrom((await incomingCall(port)).xml);
    const { ws, inbox } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    ws.send(JSON.stringify({ type: "setup", callSid: CALL_SID }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Olá", last: true }));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: "Resposta" }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Espere", last: true }));
    await waitFor(() => inbox.find((m) => m.type === "text" && m.token.includes("Claro")));
    expect(inbox.some((m) => m.type === "text" && m.token.includes("interrompida"))).toBe(false);
    // O turno abortado não ficou no histórico; a nota de interrupção foi incluída
    const msgs = stream.calls[1]!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toContain("interrompida pelo cliente");
    ws.close();
  });

  it("tecla 0 transfere para a receção", async () => {
    const { port } = await start([]);
    const path = wsPathFrom((await incomingCall(port)).xml);
    const { ws, inbox } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    ws.send(JSON.stringify({ type: "setup", callSid: CALL_SID }));
    ws.send(JSON.stringify({ type: "dtmf", digit: "0" }));
    const end = await waitFor(() => inbox.find((m) => m.type === "end"));
    expect(JSON.parse(end.handoffData).action).toBe("transfer");
    ws.close();
  });

  it("recusa do modelo resulta numa resposta segura", async () => {
    const { port } = await start([{ blocks: [], stop_reason: "refusal" }]);
    const path = wsPathFrom((await incomingCall(port)).xml);
    const { ws, inbox } = await connect(port, path, sign(`wss://voice.example.test${path}`, {}));
    ws.send(JSON.stringify({ type: "setup", callSid: CALL_SID }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "algo proibido", last: true }));
    await waitFor(() => inbox.find((m) => m.type === "text" && m.last === true));
    expect(inbox.map((m) => m.token).join("")).toContain("Peço desculpa");
    ws.close();
  });
});
