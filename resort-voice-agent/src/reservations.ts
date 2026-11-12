import { createHmac, randomUUID } from "node:crypto";
import type { Logger } from "pino";

export interface ReservationRequest {
  request_id: string;
  created_at: string;
  call_sid: string;
  caller_phone: string | null;
  guest_name: string;
  contact_phone: string | null;
  email: string | null;
  check_in: string;
  check_out: string;
  adults: number;
  children: number;
  room_type: string;
  quoted_total: number | null;
  currency: string;
  notes: string | null;
  language: string;
  consent_to_contact: true;
  status: "pending_confirmation";
}

export interface ReservationSink {
  submit(req: Omit<ReservationRequest, "request_id" | "created_at" | "status">): Promise<{ request_id: string }>;
}

/**
 * Envia o pedido para um webhook (CRM, n8n, Make, PMS...) com:
 * - Assinatura HMAC-SHA256 em "X-Signature" sobre `${timestamp}.${body}`
 * - Timestamp em "X-Timestamp" (o recetor deve rejeitar > 5 min: anti-replay)
 * - "Idempotency-Key" igual ao request_id (seguro para repetir)
 * - Timeout e 3 tentativas com backoff exponencial
 */
export class WebhookReservationSink implements ReservationSink {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async submit(input: Omit<ReservationRequest, "request_id" | "created_at" | "status">) {
    const payload: ReservationRequest = {
      ...input,
      request_id: randomUUID(),
      created_at: new Date().toISOString(),
      status: "pending_confirmation",
    };
    const body = JSON.stringify(payload);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ts = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac("sha256", this.secret).update(`${ts}.${body}`).digest("hex");
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-timestamp": ts,
            "x-signature": `sha256=${signature}`,
            "idempotency-key": payload.request_id,
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return { request_id: payload.request_id };
        lastErr = new Error(`webhook respondeu ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // não repetir erros do cliente
      } catch (err) {
        lastErr = err;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    this.log.error({ err: String(lastErr), request_id: payload.request_id }, "falha ao entregar pedido de reserva");
    throw new Error("Falha ao registar o pedido de reserva");
  }
}

/**
 * Sem webhook configurado: regista apenas um aviso SEM dados pessoais.
 * Útil para testes; em produção configure RESERVATION_WEBHOOK_URL.
 */
export class LogOnlyReservationSink implements ReservationSink {
  constructor(private readonly log: Logger) {}
  async submit(input: Omit<ReservationRequest, "request_id" | "created_at" | "status">) {
    const request_id = randomUUID();
    this.log.warn(
      { request_id, call_sid: input.call_sid, check_in: input.check_in, check_out: input.check_out, room_type: input.room_type },
      "pedido de reserva recebido mas RESERVATION_WEBHOOK_URL não está configurado (dados pessoais descartados)",
    );
    return { request_id };
  }
}
