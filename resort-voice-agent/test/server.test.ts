import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import twilio from "twilio";
import { WebSocket } from "ws";
import type { Store } from "../src/db/store.js";
import {
  ADMIN_PASSWORD,
  BASE,
  Browser,
  OWNER_PASSWORD,
  TEST_ENV,
  daysFromNow,
  freshStore,
  seedAdmin,
  seedTenant,
  startApp,
  testCrypto,
  waitFor,
  type ScriptedReply,
} from "./helpers.js";

const TOKEN = TEST_ENV.TWILIO_AUTH_TOKEN;
const CALL_SID = "CA" + "1".repeat(32);
const NUMBER_A = "+351300000001";
const NUMBER_B = "+351300000002";

let store: Store;
let tenantA: string;
let tenantB: string;
let running: Awaited<ReturnType<typeof startApp>> | null = null;

beforeAll(async () => {
  store = await freshStore();
});
afterAll(async () => {
  await store.close();
});
beforeEach(async () => {
  await store.pool.query("TRUNCATE tenants, users, web_sessions, calls, reservation_requests, leads, audit_log CASCADE");
  await seedAdmin(store);
  tenantA = await seedTenant(store, "Resort A", "a@example.test", NUMBER_A);
  tenantB = await seedTenant(store, "Resort B", "b@example.test", NUMBER_B);
});
afterEach(async () => {
  await running?.app.shutdown();
  running = null;
});

async function start(replies: ScriptedReply[] = [], overrides: Record<string, string> = {}) {
  running = await startApp(store, replies, overrides);
  return running;
}

const sign = (url: string, params: Record<string, string>) => twilio.getExpectedTwilioSignature(TOKEN, url, params);

async function postForm(port: number, path: string, params: Record<string, string>, signature?: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(signature !== undefined ? { "x-twilio-signature": signature } : {}) },
    body: new URLSearchParams(params).toString(),
  });
}
async function incomingCall(port: number, to = NUMBER_A, callSid = CALL_SID) {
  const params = { CallSid: callSid, From: "+351910000000", To: to };
  const res = await postForm(port, "/voice", params, sign(`${BASE}/voice`, params));
  return { res, xml: await res.text() };
}
function wsPathFrom(xml: string): string {
  const m = /url="wss:\/\/voice\.example\.test(\/relay\/[^"]+)"/.exec(xml);
  if (!m) throw new Error("sem url do relay na TwiML: " + xml);
  return m[1]!;
}
function connect(port: number, path: string, signed = true): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: signed ? { "x-twilio-signature": sign(`wss://voice.example.test${path}`, {}) } : {},
    });
    const inbox: any[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    ws.on("open", () => resolve({ ws, inbox }));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}
async function openCall(port: number, to = NUMBER_A) {
  const path = wsPathFrom((await incomingCall(port, to)).xml);
  const c = await connect(port, path);
  c.ws.send(JSON.stringify({ type: "setup", callSid: CALL_SID, from: "+351910000000" }));
  return c;
}

describe("voz: webhooks Twilio", () => {
  it("healthz verifica a base de dados e não expõe informação", async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("/voice rejeita pedidos sem assinatura, com assinatura errada ou adulterados", async () => {
    const { port } = await start();
    const params = { CallSid: CALL_SID, To: NUMBER_A };
    expect((await postForm(port, "/voice", params)).status).toBe(403);
    expect((await postForm(port, "/voice", params, "AAAA")).status).toBe(403);
    expect((await postForm(port, "/voice", { ...params, To: NUMBER_B }, sign(`${BASE}/voice`, params))).status).toBe(403);
  });

  it("encaminha cada número para o perfil do respetivo resort", async () => {
    const { port } = await start();
    const profile = (await store.tenantById(tenantB))!.profile;
    profile.languages[0]!.welcomeGreeting = "Bem-vindo ao Resort B, fala o assistente virtual de inteligência artificial.";
    await store.updateProfile(tenantB, profile);
    const a = await incomingCall(port, NUMBER_A);
    const b = await incomingCall(port, NUMBER_B, "CA" + "2".repeat(32));
    expect(a.xml).toContain("<ConversationRelay");
    expect(a.xml).not.toContain("Resort B");
    expect(b.xml).toContain("Bem-vindo ao Resort B");
    expect(b.xml).toContain(`action="${BASE}/handoff"`);
  });

  it("número desconhecido ou cliente suspenso não chega ao assistente", async () => {
    const { port } = await start();
    expect((await incomingCall(port, "+351300000099")).xml).not.toContain("ConversationRelay");
    await store.updateTenantAdmin(tenantA, { status: "suspended", twilio_number: NUMBER_A, max_concurrent_calls: 5, monthly_minutes_limit: 500 });
    const { xml } = await incomingCall(port);
    expect(xml).not.toContain("ConversationRelay");
    expect(xml).toContain("<Hangup/>");
  });

  it("ao atingir os minutos do plano, a chamada vai para a receção", async () => {
    const { port } = await start();
    await store.updateTenantAdmin(tenantA, { status: "active", twilio_number: NUMBER_A, max_concurrent_calls: 5, monthly_minutes_limit: 10 });
    await store.startCall(tenantA, "CA" + "7".repeat(32), "x");
    await store.endCall("CA" + "7".repeat(32), { duration_s: 600, turns: 5, outcome: "end", language: "pt-PT" });
    const { xml } = await incomingCall(port);
    expect(xml).toContain("<Dial");
    expect(xml).toContain("+351210000000");
    expect(xml).not.toContain("ConversationRelay");
  });

  it("/handoff transfere para a receção do resort certo, ou desliga", async () => {
    const { port } = await start();
    await store.updateReception(tenantB, "+351220000000");
    const transfer = { CallSid: CALL_SID, To: NUMBER_B, HandoffData: JSON.stringify({ action: "transfer", language: "pt-PT" }) };
    const t = await (await postForm(port, "/handoff", transfer, sign(`${BASE}/handoff`, transfer))).text();
    expect(t).toContain("+351220000000");
    const end = { CallSid: CALL_SID, To: NUMBER_A, HandoffData: JSON.stringify({ action: "end", language: "en-GB" }) };
    const e = await (await postForm(port, "/handoff", end, sign(`${BASE}/handoff`, end))).text();
    expect(e).toContain("<Hangup/>");
    expect(e).not.toContain("<Dial");
    const broken = { CallSid: CALL_SID, To: NUMBER_A, HandoffData: "{nope" };
    expect(await (await postForm(port, "/handoff", broken, sign(`${BASE}/handoff`, broken))).text()).toContain("<Dial");
  });
});

describe("voz: sessão ConversationRelay", () => {
  it("rejeita upgrade sem assinatura, com token inválido ou reutilizado", async () => {
    const { port } = await start();
    const path = wsPathFrom((await incomingCall(port)).xml);
    await expect(connect(port, path, false)).rejects.toThrow(/403/);
    await expect(connect(port, "/relay/abc.def")).rejects.toThrow(/403/);
    await expect(connect(port, "/outro")).rejects.toThrow(/404/);
    const { ws } = await connect(port, path);
    ws.close();
    await expect(connect(port, path)).rejects.toThrow(/403/);
  });

  it("fecha a sessão se o CallSid do setup não corresponder", async () => {
    const { port } = await start();
    const { ws } = await connect(port, wsPathFrom((await incomingCall(port)).xml));
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.send(JSON.stringify({ type: "setup", callSid: "CA" + "9".repeat(32) }));
    expect(await closed).toBe(1008);
  });

  it("conversa: disponibilidade, resposta em streaming e registo da chamada", async () => {
    const { port, stream } = await start([
      {
        blocks: [
          { type: "text", text: "Vou verificar." },
          { type: "tool_use", id: "tu_1", name: "check_availability", input: { check_in: daysFromNow(20), check_out: daysFromNow(23), adults: 2 } },
        ],
      },
      { blocks: [{ type: "text", text: "Temos o **quarto** vista mar por 480 euros." }] },
    ]);
    const { ws, inbox } = await openCall(port);
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Quero um quarto para dois", last: true }));
    await waitFor(() => inbox.find((m) => m.type === "text" && m.last === true));
    const spoken = inbox.filter((m) => m.type === "text").map((m) => m.token).join("");
    expect(spoken).toContain("Vou verificar.");
    expect(spoken).toContain("Temos o quarto vista mar");
    expect(spoken).not.toContain("**");

    const second = stream.calls[1]!;
    const last = second.messages[second.messages.length - 1]!;
    expect(JSON.parse((last.content as any)[0].content).offers.length).toBeGreaterThan(0);
    expect(second.model).toBe("claude-opus-5-5");
    expect(second.fallbacks).toBe("default");
    expect(JSON.stringify(second.system)).toContain("Resort A");

    ws.close();
    const call = await waitFor(async () => (await store.listCalls(tenantA)).find((c) => c.outcome !== null));
    expect(call).toMatchObject({ call_sid: CALL_SID, turns: 1, outcome: "hangup", language: "pt-PT" });
    expect(call.caller_hash).not.toContain("910000000");
    expect(await store.listCalls(tenantB)).toHaveLength(0);
  });

  it("pedido de reserva fica guardado cifrado e só no resort certo", async () => {
    const { port } = await start([
      {
        blocks: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "create_reservation_request",
            input: {
              guest_name: "Ana Silva", email: "ana@example.com", check_in: daysFromNow(20), check_out: daysFromNow(23),
              adults: 2, room_type: "duplo_mar", caller_confirmed_summary: true, consent_to_contact: true,
            },
          },
        ],
      },
      { blocks: [{ type: "text", text: "Pedido registado." }] },
    ]);
    const { ws, inbox } = await openCall(port);
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Sim, confirmo", last: true }));
    await waitFor(() => inbox.find((m) => m.type === "text" && m.last === true));
    ws.close();

    const rows = await store.listReservations(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ room_type: "duplo_mar", adults: 2, status: "pending", quoted_total: "480.00" });
    expect(rows[0]!.pii_enc).not.toContain("Ana");
    expect(JSON.parse(testCrypto().decrypt(rows[0]!.pii_enc!))).toMatchObject({ guest_name: "Ana Silva", email: "ana@example.com", caller_phone: "+351910000000" });
    expect(await store.listReservations(tenantB)).toHaveLength(0);
  });

  it("transferência, mudança de idioma e tecla 0", async () => {
    const { port } = await start([
      { blocks: [{ type: "tool_use", id: "tu_1", name: "switch_language", input: { language_code: "en-GB" } }] },
      { blocks: [{ type: "text", text: "Of course." }] },
      { blocks: [{ type: "text", text: "Transferring you." }, { type: "tool_use", id: "tu_2", name: "transfer_to_human", input: { reason: "asked" } }] },
    ]);
    const { ws, inbox } = await openCall(port);
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Do you speak English?", last: true }));
    await waitFor(() => inbox.find((m) => m.type === "text" && m.last === true));
    expect(inbox.find((m) => m.type === "language")).toEqual({ type: "language", ttsLanguage: "en-GB", transcriptionLanguage: "en-GB" });
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "A person please", last: true }));
    const end = await waitFor(() => inbox.find((m) => m.type === "end"));
    expect(JSON.parse(end.handoffData)).toMatchObject({ action: "transfer", language: "en-GB" });
    ws.close();
    const call = await waitFor(async () => (await store.listCalls(tenantA)).find((c) => c.outcome !== null));
    expect(call.outcome).toBe("transfer");
  });

  it("interrupção aborta a resposta em curso; recusa do modelo dá resposta segura", async () => {
    const { port, stream } = await start([
      { blocks: [{ type: "text", text: "Resposta lenta que vai ser interrompida" }], delayMs: 300 },
      { blocks: [], stop_reason: "refusal" },
    ]);
    const { ws, inbox } = await openCall(port);
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Olá", last: true }));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: "Resposta" }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Espere", last: true }));
    await waitFor(() => inbox.find((m) => m.type === "text" && m.token.includes("Peço desculpa")));
    expect(inbox.some((m) => m.type === "text" && m.token.includes("interrompida"))).toBe(false);
    expect(stream.calls[1]!.messages).toHaveLength(1);
    expect(stream.calls[1]!.messages[0]!.content).toContain("interrompida pelo cliente");
    ws.close();
  });
});

describe("web: autenticação e sessões", () => {
  it("páginas públicas respondem com cabeçalhos de segurança", async () => {
    const { port } = await start();
    const b = new Browser(port);
    const home = await b.get("/");
    expect(home.status).toBe(200);
    expect(home.body).toContain("Atendia");
    expect(home.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(home.headers.get("x-frame-options")).toBeTruthy();
    expect((await b.get("/privacidade")).status).toBe(200);
    expect((await b.get("/assets/styles.css")).status).toBe(200);
    expect((await b.get("/assets/../package.json")).status).toBe(404);
  });

  it("painel exige sessão; login errado não revela se o e-mail existe", async () => {
    const { port } = await start();
    const b = new Browser(port);
    for (const p of ["/app", "/app/reservas", "/admin", "/conta"]) expect((await b.get(p)).location).toBe("/login");
    const wrong = await b.login("a@example.test", "password-errada-1");
    const unknown = await b.login("ninguem@example.test", "password-errada-1");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toContain("E-mail ou palavra-passe incorretos.");
    expect(unknown.body).toContain("E-mail ou palavra-passe incorretos.");
  });

  it("login cria cookie seguro; logout invalida a sessão", async () => {
    const { port } = await start();
    const b = new Browser(port);
    const res = await b.login("a@example.test", OWNER_PASSWORD);
    expect(res.location).toBe("/app");
    expect(res.setCookie).toMatch(/^__Host-sid=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    expect((await b.get("/app")).body).toContain("Resort A");
    const old = b.cookie;
    await b.post("/logout", {});
    b.cookie = old;
    expect((await b.get("/app")).location).toBe("/login");
  });

  it("bloqueia a conta após 8 tentativas falhadas", async () => {
    const { port } = await start();
    const b = new Browser(port);
    for (let i = 0; i < 8; i++) await b.login("a@example.test", "password-errada-1");
    const res = await b.login("a@example.test", OWNER_PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body).toContain("bloqueada");
  });

  it("rejeita POST de outra origem, sem origem ou sem token CSRF", async () => {
    const { port } = await start();
    const b = new Browser(port);
    expect((await b.post("/login", { email: "a@example.test", password: OWNER_PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await b.post("/login", { email: "a@example.test", password: OWNER_PASSWORD }, { origin: null })).status).toBe(403);
    await b.login("a@example.test", OWNER_PASSWORD);
    expect((await b.post("/app/resort/informacao", { facilities: "x" }, { csrf: false })).status).toBe(403);
    expect((await b.post("/app/resort/informacao", { facilities: "x" }, { csrf: "token-errado" })).status).toBe(403);
  });

  it("alterar a palavra-passe exige a atual e cumpre a política", async () => {
    const { port } = await start();
    const b = new Browser(port);
    await b.login("a@example.test", OWNER_PASSWORD);
    expect((await b.post("/conta", { current: "errada-123456", password: "nova-password-456", confirm: "nova-password-456" })).status).toBe(400);
    expect((await b.post("/conta", { current: OWNER_PASSWORD, password: "curta1", confirm: "curta1" })).status).toBe(400);
    expect((await b.post("/conta", { current: OWNER_PASSWORD, password: "nova-password-456", confirm: "nova-password-456" })).location).toBe("/conta?ok=password");
    const again = new Browser(port);
    expect((await again.login("a@example.test", OWNER_PASSWORD)).status).toBe(401);
    expect((await again.login("a@example.test", "nova-password-456")).location).toBe("/app");
  });
});

describe("web: painel do resort", () => {
  it("o dono não acede à administração nem aos dados de outro resort", async () => {
    const { port } = await start();
    const b = new Browser(port);
    await b.login("a@example.test", OWNER_PASSWORD);
    expect((await b.get("/admin")).location).toBe("/app");
    expect((await b.post("/admin/clientes/novo", { name: "X", email: "x@example.test" })).location).toBe("/app");

    const id = await store.insertReservation({
      tenant_id: tenantB, call_sid: "CA1", pii_enc: testCrypto().encrypt(JSON.stringify({ guest_name: "Hóspede B" })),
      check_in: "2030-01-01", check_out: "2030-01-03", room_type: "duplo_mar", adults: 2, children: 0, quoted_total: 320, currency: "EUR",
    });
    expect((await b.get("/app/reservas")).body).not.toContain("Hóspede B");
    expect((await b.post(`/app/reservas/${id}/estado`, { status: "confirmed" })).status).toBe(404);
    expect((await store.listReservations(tenantB))[0]!.status).toBe("pending");
  });

  it("mostra e atualiza os pedidos de reserva, escapando HTML", async () => {
    const { port } = await start();
    const id = await store.insertReservation({
      tenant_id: tenantA, call_sid: "CA1",
      pii_enc: testCrypto().encrypt(JSON.stringify({ guest_name: "<script>alert(1)</script>", email: "ana@example.com", caller_phone: null, contact_phone: null, notes: null, language: "pt-PT" })),
      check_in: "2030-01-01", check_out: "2030-01-03", room_type: "duplo_mar", adults: 2, children: 0, quoted_total: 320, currency: "EUR",
    });
    const b = new Browser(port);
    await b.login("a@example.test", OWNER_PASSWORD);
    const page = await b.get("/app/reservas");
    expect(page.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page.body).not.toContain("<script>alert(1)</script>");
    expect(page.body).toContain("Quarto Duplo Vista Mar");
    expect((await b.post(`/app/reservas/${id}/estado`, { status: "confirmed" })).location).toBe("/app/reservas?ok=estado");
    expect((await store.listReservations(tenantA))[0]!.status).toBe("confirmed");
  });

  it("edita quartos: altera, adiciona, remove e valida", async () => {
    const { port } = await start();
    const b = new Browser(port);
    await b.login("a@example.test", OWNER_PASSWORD);
    const ok = await b.post("/app/resort/quartos", {
      room_id: ["duplo_mar", "", ""],
      room_name: ["Duplo Mar Premium", "Villa com Piscina", ""],
      room_description: ["Vista mar frontal.", "Villa privada com três quartos.", ""],
      room_rate: ["180", "450,50", ""],
      room_units: ["10", "2", ""],
      room_adults: ["2", "6", ""],
      room_children: ["1", "2", ""],
      room_occupancy: ["3", "8", ""],
    });
    expect(ok.location).toBe("/app/resort/quartos?ok=guardado");
    const rooms = (await store.tenantById(tenantA))!.profile.rooms;
    expect(rooms.map((r) => r.id)).toEqual(["duplo_mar", "villa_com_piscina"]);
    expect(rooms[1]).toMatchObject({ nightly_rate_from: 450.5, max_occupancy: 8 });

    const bad = await b.post("/app/resort/quartos", {
      room_id: [""], room_name: ["Sem preço"], room_description: ["Descrição válida."], room_rate: ["abc"],
      room_units: ["1"], room_adults: ["2"], room_children: ["0"], room_occupancy: ["2"],
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toContain("Quarto 1 · Preço por noite");
    expect(bad.body).toContain('value="Sem preço"'); // o que foi escrito não se perde
    expect((await store.tenantById(tenantA))!.profile.rooms).toHaveLength(2);
    expect((await b.post("/app/resort/quartos", { room_name: [""] })).body).toContain("Adicione pelo menos um quarto.");
  });

  it("edita dados gerais, informação e idiomas", async () => {
    const { port } = await start();
    const b = new Browser(port);
    await b.login("a@example.test", OWNER_PASSWORD);
    const general = { name: "Resort A Renovado", address: "Rua Nova 1, Faro", website: "", email: "", min_nights: "1", max_nights: "14", max_days_in_advance: "300" };
    expect((await b.post("/app/resort", { ...general, reception_phone: "912345678" })).status).toBe(400);
    expect((await b.post("/app/resort", { ...general, reception_phone: "+351 289 000 000" })).location).toBe("/app/resort?ok=guardado");
    await b.post("/app/resort/informacao", { policy_a: ["Check-in", ""], policy_b: ["a partir das 16h00", ""], facilities: "Piscina\n\nSpa", faq_a: ["Têm ginásio?"], faq_b: ["Sim, 24 horas."] });
    await b.post("/app/resort/idiomas", { primary: "en-GB", lang: ["pt-PT", "de-DE"], "greeting_en-GB": "Hello, this is the virtual assistant, an AI system.", "greeting_pt-PT": "Olá, fala o assistente virtual de inteligência artificial.", "greeting_de-DE": "Guten Tag, hier ist der virtuelle KI-Assistent." });
    const t = (await store.tenantById(tenantA))!;
    expect(t.name).toBe("Resort A Renovado");
    expect(t.reception_phone).toBe("+351289000000");
    expect(t.profile.booking_rules.max_nights).toBe(14);
    expect(t.profile.policies).toEqual({ "Check-in": "a partir das 16h00" });
    expect(t.profile.facilities).toEqual(["Piscina", "Spa"]);
    expect(t.profile.faq).toEqual([{ q: "Têm ginásio?", a: "Sim, 24 horas." }]);
    expect(t.profile.languages.map((l) => l.code)).toEqual(["en-GB", "pt-PT", "de-DE"]);
    expect((await b.get("/app")).body).toContain("Está tudo em dia");
  });

  it("integrações: recusa destinos internos, gera o segredo uma vez e guarda-o cifrado", async () => {
    const { port } = await start();
    const b = new Browser(port);
    await b.login("a@example.test", OWNER_PASSWORD);
    expect((await b.post("/app/integracoes", { webhook_url: "http://hook.example.com/x" })).status).toBe(400);
    expect((await b.post("/app/integracoes", { webhook_url: "https://169.254.169.254/latest/meta-data" })).status).toBe(400);
    expect((await b.post("/app/integracoes", { pms_url: "https://pms.example.com/api" })).body).toContain("indique o token");

    const saved = await b.post("/app/integracoes", { webhook_url: "https://hook.example.com/reservas", pms_url: "https://pms.example.com/api/", pms_token: "token-secreto-do-pms" });
    const secret = /id="new-secret">([^<]+)</.exec(saved.body)![1]!;
    const t = (await store.tenantById(tenantA))!;
    expect(testCrypto().decrypt(t.webhook_secret_enc!)).toBe(secret);
    expect(t.pms_url).toBe("https://pms.example.com/api");
    expect(t.pms_token_enc).not.toContain("token-secreto");
    const again = await b.get("/app/integracoes");
    expect(again.body).not.toContain(secret);
    expect(again.body).not.toContain("token-secreto-do-pms");
  });
});

describe("web: administração e site", () => {
  it("admin cria cliente com palavra-passe temporária de alteração obrigatória", async () => {
    const { port } = await start();
    const admin = new Browser(port);
    expect((await admin.login(TEST_ENV.ADMIN_EMAIL, ADMIN_PASSWORD)).location).toBe("/admin");
    expect((await admin.post("/admin/clientes/novo", { name: "Resort C", email: "a@example.test" })).body).toContain("Já existe uma conta");
    const created = await admin.post("/admin/clientes/novo", { name: "Resort C", email: "C@Example.test" });
    const temp = /id="tmp-pw">([^<]+)</.exec(created.body)![1]!;
    expect(created.body).toContain(`${BASE}/voice`);

    const owner = new Browser(port);
    expect((await owner.login("c@example.test", temp)).location).toBe("/app");
    expect((await owner.get("/app")).location).toBe("/conta");
    await owner.post("/conta", { current: temp, password: "definitiva-pass-789", confirm: "definitiva-pass-789" });
    expect((await owner.get("/app")).body).toContain("Primeiros passos");
  });

  it("admin atribui número (único), altera limites e repõe a palavra-passe", async () => {
    const { port } = await start();
    const admin = new Browser(port);
    await admin.login(TEST_ENV.ADMIN_EMAIL, ADMIN_PASSWORD);
    const base = { status: "active", monthly_minutes_limit: "1000", max_concurrent_calls: "8" };
    expect((await admin.post(`/admin/clientes/${tenantA}`, { ...base, twilio_number: NUMBER_B })).body).toContain("já está atribuído a Resort B");
    expect((await admin.post(`/admin/clientes/${tenantA}`, { ...base, twilio_number: "+351300000055" })).location).toBe(`/admin/clientes/${tenantA}?ok=guardado`);
    expect(await store.tenantById(tenantA)).toMatchObject({ twilio_number: "+351300000055", monthly_minutes_limit: 1000, max_concurrent_calls: 8 });
    expect((await admin.get("/admin")).body).toContain("Resort B");

    const owner = new Browser(port);
    await owner.login("a@example.test", OWNER_PASSWORD);
    const reset = await admin.post(`/admin/clientes/${tenantA}/palavra-passe`, {});
    expect(reset.body).toMatch(/id="tmp-pw">/);
    expect((await owner.get("/app")).location).toBe("/login"); // sessões antigas terminadas
  });

  it("formulário de demonstração guarda o pedido e ignora bots", async () => {
    const { port } = await start();
    const b = new Browser(port);
    const lead = { name: "Rita Costa", company: "Hotel Praia", email: "rita@hotelpraia.pt", phone: "", message: "Quero ver uma demonstração", consent: "1" };
    expect((await b.post("/lead", lead)).location).toBe("/?ok=lead#demo");
    expect((await b.post("/lead", { ...lead, website: "http://spam.example" })).location).toBe("/?ok=lead#demo");
    expect((await b.post("/lead", { ...lead, consent: "" })).status).toBe(400);
    expect((await b.post("/lead", { ...lead, email: "não-é-email" })).status).toBe(400);
    expect(await store.listLeads()).toHaveLength(1);
    const admin = new Browser(port);
    await admin.login(TEST_ENV.ADMIN_EMAIL, ADMIN_PASSWORD);
    expect((await admin.get("/admin/leads")).body).toContain("Hotel Praia");
  });

  it("retenção apaga os dados pessoais antigos mas mantém o registo", async () => {
    await store.insertReservation({
      tenant_id: tenantA, call_sid: "CA1", pii_enc: testCrypto().encrypt("{}"),
      check_in: "2030-01-01", check_out: "2030-01-03", room_type: "duplo_mar", adults: 2, children: 0, quoted_total: 320, currency: "EUR",
    });
    expect(await store.purge(90)).toBe(0);
    await store.pool.query("UPDATE reservation_requests SET created_at = now() - interval '91 days'");
    expect(await store.purge(90)).toBe(1);
    const rows = await store.listReservations(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pii_enc).toBeNull();
  });
});
