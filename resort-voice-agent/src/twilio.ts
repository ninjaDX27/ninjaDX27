import { createHmac, timingSafeEqual } from "node:crypto";
import twilio from "twilio";
import type { Resort } from "./resort.js";

const { validateRequest } = twilio;
const VoiceResponse = twilio.twiml.VoiceResponse;

/** Valida o cabeçalho X-Twilio-Signature (HMAC-SHA1 do URL + parâmetros). */
export function isValidTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Record<string, unknown>,
): boolean {
  if (!signature || signature.length > 200) return false;
  try {
    return validateRequest(authToken, signature, url, params);
  } catch {
    return false;
  }
}

/**
 * Token de sessão por chamada, de uso único e curta duração, incluído no
 * caminho do WebSocket. Liga o WebSocket a uma chamada que passou pelo
 * webhook /voice validado. Defesa em profundidade além da assinatura Twilio.
 */
export class SessionTokens {
  private readonly used = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly ttlMs = 120_000,
  ) {}

  issue(callSid: string, tenantId: string, now = Date.now()): string {
    const payload = Buffer.from(JSON.stringify({ c: callSid, t: tenantId, e: now + this.ttlMs })).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** Devolve a chamada e o cliente se o token for válido e ainda não usado. */
  consume(token: string, now = Date.now()): { callSid: string; tenantId: string } | null {
    if (typeof token !== "string" || token.length > 512) return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let data: { c?: unknown; t?: unknown; e?: unknown };
    try {
      data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof data.c !== "string" || typeof data.t !== "string" || typeof data.e !== "number" || data.e < now) return null;
    this.gc(now);
    if (this.used.has(token)) return null;
    this.used.set(token, data.e);
    return { callSid: data.c, tenantId: data.t };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private gc(now: number): void {
    for (const [t, exp] of this.used) if (exp < now) this.used.delete(t);
  }
}

export function relayTwiml(opts: {
  resort: Resort;
  wsUrl: string;
  actionUrl: string;
}): string {
  const primary = opts.resort.languages[0]!;
  const response = new VoiceResponse();
  const connect = response.connect({ action: opts.actionUrl, method: "POST" });
  const relay = connect.conversationRelay({
    url: opts.wsUrl,
    language: primary.code,
    welcomeGreeting: primary.welcomeGreeting,
    welcomeGreetingInterruptible: "any",
    interruptible: "any",
    dtmfDetection: true,
    profanityFilter: true,
    ...(primary.ttsProvider ? { ttsProvider: primary.ttsProvider } : {}),
    ...(primary.voice ? { voice: primary.voice } : {}),
    ...(primary.transcriptionProvider ? { transcriptionProvider: primary.transcriptionProvider } : {}),
  });
  for (const l of opts.resort.languages) {
    relay.language({
      code: l.code,
      ...(l.ttsProvider ? { ttsProvider: l.ttsProvider } : {}),
      ...(l.voice ? { voice: l.voice } : {}),
      ...(l.transcriptionProvider ? { transcriptionProvider: l.transcriptionProvider } : {}),
    });
  }
  return response.toString();
}

const BUSY_MSG: Record<string, string> = {
  pt: "Obrigado por ligar. Vamos transferir a sua chamada para a receção.",
  en: "Thank you for calling. We are transferring your call to reception.",
};
const UNAVAILABLE_MSG: Record<string, string> = {
  pt: "Lamentamos, a receção não está disponível neste momento. Por favor, tente mais tarde. Obrigado.",
  en: "We are sorry, reception is not available right now. Please try again later. Thank you.",
};
const GOODBYE_MSG: Record<string, string> = {
  pt: "Obrigado pela sua chamada. Até breve.",
  en: "Thank you for calling. Goodbye.",
};

type SayLang = "pt-PT" | "en-GB";
function sayLanguage(code: string): { key: "pt" | "en"; lang: SayLang } {
  return code.startsWith("pt") ? { key: "pt", lang: "pt-PT" } : { key: "en", lang: "en-GB" };
}

export function dialReceptionTwiml(reception: string, langCode: string, announce = false): string {
  const { key, lang } = sayLanguage(langCode);
  const r = new VoiceResponse();
  if (announce) r.say({ language: lang }, BUSY_MSG[key]!);
  r.dial({ timeout: 30, answerOnBridge: true }, reception);
  r.say({ language: lang }, UNAVAILABLE_MSG[key]!);
  r.hangup();
  return r.toString();
}

export function hangupTwiml(langCode: string): string {
  const { key, lang } = sayLanguage(langCode);
  const r = new VoiceResponse();
  r.say({ language: lang }, GOODBYE_MSG[key]!);
  r.hangup();
  return r.toString();
}

const NOT_CONFIGURED: Record<string, string> = {
  pt: "Este número não está disponível de momento. Por favor, tente mais tarde.",
  en: "This number is not available at the moment. Please try again later.",
};

export function unavailableTwiml(): string {
  const r = new VoiceResponse();
  r.say({ language: "pt-PT" }, NOT_CONFIGURED.pt!);
  r.say({ language: "en-GB" }, NOT_CONFIGURED.en!);
  r.hangup();
  return r.toString();
}

/** Encaminha para a receção se houver número; caso contrário despede-se. */
export function fallbackTwiml(reception: string | null, langCode: string, announce: boolean): string {
  return reception ? dialReceptionTwiml(reception, langCode, announce) : unavailableTwiml();
}
