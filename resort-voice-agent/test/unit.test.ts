import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { HttpAvailabilityProvider, StaticAvailabilityProvider, validateStay } from "../src/availability.js";
import { loadConfig } from "../src/config.js";
import { WebhookReservationSink, type ReservationSink } from "../src/reservations.js";
import { buildSystemPrompt } from "../src/resort.js";
import { sanitizeForSpeech } from "../src/session.js";
import { executeTool, type ToolContext } from "../src/tools.js";
import { SessionTokens } from "../src/twilio.js";
import { TEST_ENV, daysFromNow, silentLog, testResort } from "./helpers.js";

const resort = testResort();

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  const reservations: ReservationSink = { submit: vi.fn(async () => ({ request_id: "abcdef12-0000" })) };
  return {
    resort,
    availability: new StaticAvailabilityProvider(resort),
    reservations,
    callSid: "CA" + "0".repeat(32),
    callerPhone: "+351910000000",
    language: "pt-PT",
    counters: { availability: 0, reservations: 0 },
    ...overrides,
  };
}

describe("config", () => {
  it("aceita uma configuração válida", () => {
    const c = loadConfig(TEST_ENV as NodeJS.ProcessEnv);
    expect(c.CLAUDE_MODEL).toBe("claude-opus-5-5");
    expect(c.TWILIO_VALIDATE_SIGNATURE).toBe(true);
  });

  it("rejeita URL não HTTPS e não revela segredos no erro", () => {
    expect(() => loadConfig({ ...TEST_ENV, PUBLIC_BASE_URL: "http://x.test" } as NodeJS.ProcessEnv)).toThrow(/PUBLIC_BASE_URL/);
    try {
      loadConfig({ ...TEST_ENV, SESSION_SIGNING_SECRET: "curto" } as NodeJS.ProcessEnv);
    } catch (e) {
      expect((e as Error).message).not.toContain(TEST_ENV.TWILIO_AUTH_TOKEN);
      expect((e as Error).message).toContain("SESSION_SIGNING_SECRET");
    }
  });

  it("não permite desligar a validação Twilio em produção", () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, NODE_ENV: "production", TWILIO_VALIDATE_SIGNATURE: "false" } as NodeJS.ProcessEnv),
    ).toThrow(/TWILIO_VALIDATE_SIGNATURE/);
  });

  it("exige segredo quando há webhook de reservas", () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, RESERVATION_WEBHOOK_URL: "https://hook.test/x" } as NodeJS.ProcessEnv),
    ).toThrow(/RESERVATION_WEBHOOK_SECRET/);
  });
});

describe("validateStay", () => {
  const base = { adults: 2, children: 0 };
  it("aceita estadia válida", () => {
    const r = validateStay({ ...base, check_in: daysFromNow(10), check_out: daysFromNow(13) }, resort);
    expect(r).toEqual({ ok: true, nights: 3 });
  });
  it("rejeita datas passadas, invertidas, impossíveis e fora das regras", () => {
    expect(validateStay({ ...base, check_in: daysFromNow(-3), check_out: daysFromNow(2) }, resort).ok).toBe(false);
    expect(validateStay({ ...base, check_in: daysFromNow(10), check_out: daysFromNow(9) }, resort).ok).toBe(false);
    expect(validateStay({ ...base, check_in: "2030-02-30", check_out: "2030-03-03" }, resort).ok).toBe(false);
    expect(validateStay({ ...base, check_in: daysFromNow(10), check_out: daysFromNow(11) }, resort).ok).toBe(false); // min 2
    expect(validateStay({ ...base, check_in: daysFromNow(10), check_out: daysFromNow(40) }, resort).ok).toBe(false); // max 21
    expect(validateStay({ ...base, check_in: daysFromNow(400), check_out: daysFromNow(403) }, resort).ok).toBe(false);
  });
});

describe("ferramentas", () => {
  it("check_availability devolve ofertas compatíveis com a ocupação", async () => {
    const out = await executeTool(
      "check_availability",
      { check_in: daysFromNow(10), check_out: daysFromNow(12), adults: 4, children: 1 },
      ctx(),
    );
    expect(out.isError).toBe(false);
    const data = JSON.parse(out.content);
    expect(data.offers.map((o: { room_type: string }) => o.room_type)).toEqual(["suite_familiar"]);
    expect(data.offers[0].total_price).toBe(520);
  });

  it("rejeita parâmetros extra ou inválidos", async () => {
    const out = await executeTool("check_availability", { check_in: "amanhã", adults: 2, hack: 1 }, ctx());
    expect(out.isError).toBe(true);
  });

  it("limita o número de pesquisas por chamada", async () => {
    const c = ctx();
    const q = { check_in: daysFromNow(10), check_out: daysFromNow(12), adults: 2 };
    for (let i = 0; i < 10; i++) expect((await executeTool("check_availability", q, c)).isError).toBe(false);
    expect((await executeTool("check_availability", q, c)).isError).toBe(true);
  });

  it("pedido de reserva exige confirmação e consentimento explícitos", async () => {
    const c = ctx();
    const base = {
      guest_name: "Ana Silva",
      email: "ana@example.com",
      check_in: daysFromNow(10),
      check_out: daysFromNow(12),
      adults: 2,
      room_type: "duplo_mar",
    };
    expect((await executeTool("create_reservation_request", base, c)).isError).toBe(true);
    expect(
      (await executeTool("create_reservation_request", { ...base, caller_confirmed_summary: true, consent_to_contact: false }, c))
        .isError,
    ).toBe(true);
    const ok = await executeTool(
      "create_reservation_request",
      { ...base, caller_confirmed_summary: true, consent_to_contact: true, notes: "Andar alto <script>" },
      c,
    );
    expect(ok.isError).toBe(false);
    const submitted = (c.reservations.submit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.notes).toBe("Andar alto script");
    expect(submitted.quoted_total).toBe(320);
  });

  it("rejeita ocupação acima da capacidade do quarto", async () => {
    const out = await executeTool(
      "create_reservation_request",
      {
        guest_name: "Rui",
        check_in: daysFromNow(10),
        check_out: daysFromNow(12),
        adults: 4,
        room_type: "duplo_mar",
        caller_confirmed_summary: true,
        consent_to_contact: true,
      },
      ctx(),
    );
    expect(out.isError).toBe(true);
  });

  it("transfer, end e switch_language devolvem ações", async () => {
    expect((await executeTool("transfer_to_human", { reason: "reclamação" }, ctx())).action?.type).toBe("transfer");
    expect((await executeTool("end_call", {}, ctx())).action?.type).toBe("end");
    expect((await executeTool("switch_language", { language_code: "en-GB" }, ctx())).action).toEqual({
      type: "switch_language",
      code: "en-GB",
    });
    expect((await executeTool("switch_language", { language_code: "de-DE" }, ctx())).isError).toBe(true);
    expect((await executeTool("rm_rf", {}, ctx())).isError).toBe(true);
  });
});

describe("SessionTokens", () => {
  const sid = "CA" + "a".repeat(32);
  it("é de uso único", () => {
    const t = new SessionTokens("s".repeat(40));
    const tok = t.issue(sid);
    expect(t.consume(tok)).toBe(sid);
    expect(t.consume(tok)).toBeNull();
  });
  it("rejeita tokens adulterados, de outro segredo ou expirados", () => {
    const t = new SessionTokens("s".repeat(40), 1000);
    const tok = t.issue(sid);
    const [p, s] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ c: "CA" + "b".repeat(32), e: Date.now() + 9e6 })).toString("base64url");
    expect(t.consume(`${forged}.${s}`)).toBeNull();
    expect(new SessionTokens("o".repeat(40)).consume(tok)).toBeNull();
    expect(t.consume(`${p}.${s}`, Date.now() + 5000)).toBeNull();
    expect(t.consume("lixo")).toBeNull();
  });
});

describe("integrações externas", () => {
  it("webhook de reservas assina com HMAC e timestamp", async () => {
    const secret = "w".repeat(40);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }));
    const sink = new WebhookReservationSink("https://hook.test/r", secret, silentLog, fetchMock as typeof fetch);
    await sink.submit({
      call_sid: "CA1",
      caller_phone: null,
      guest_name: "Ana",
      contact_phone: null,
      email: "a@b.pt",
      check_in: "2030-01-01",
      check_out: "2030-01-03",
      adults: 2,
      children: 0,
      room_type: "duplo_mar",
      quoted_total: 320,
      currency: "EUR",
      notes: null,
      language: "pt-PT",
      consent_to_contact: true,
    });
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    const expected = createHmac("sha256", secret).update(`${headers["x-timestamp"]}.${init.body}`).digest("hex");
    expect(headers["x-signature"]).toBe(`sha256=${expected}`);
    expect(init.redirect).toBe("error");
  });

  it("webhook não repete erros 4xx e lança erro", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
    const sink = new WebhookReservationSink("https://hook.test/r", "w".repeat(40), silentLog, fetchMock as typeof fetch);
    await expect(sink.submit({} as never)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("PMS HTTP valida a resposta e ignora quartos desconhecidos", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        rooms: [
          { room_type: "duplo_mar", available_units: 0, total_price: 300, currency: "EUR" },
          { room_type: "inexistente", available_units: 3, total_price: 1, currency: "EUR" },
        ],
      }),
    );
    const p = new HttpAvailabilityProvider(resort, "https://pms.test", "token-123", 1000, fetchMock as typeof fetch);
    const offers = await p.check({ check_in: daysFromNow(5), check_out: daysFromNow(7), adults: 2, children: 0 });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ room_type: "duplo_mar", available: false, price_is_estimate: false });
  });

  it("PMS HTTP rejeita respostas mal formadas", async () => {
    const fetchMock = vi.fn(async () => Response.json({ rooms: "nope" }));
    const p = new HttpAvailabilityProvider(resort, "https://pms.test", "token-123", 1000, fetchMock as typeof fetch);
    await expect(p.check({ check_in: daysFromNow(5), check_out: daysFromNow(7), adults: 2, children: 0 })).rejects.toThrow();
  });
});

describe("prompt e voz", () => {
  it("o prompt de sistema é estável (sem data) e inclui regras de segurança", () => {
    const a = buildSystemPrompt(resort);
    expect(a).toBe(buildSystemPrompt(resort));
    expect(a).toContain("NUNCA peças nem aceites dados de cartão");
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  it("remove markdown e emojis do texto falado", () => {
    expect(sanitizeForSpeech("**Olá** 😀 # bem-vindo")).toBe("Olá   bem-vindo");
  });
});
