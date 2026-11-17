import { createHmac } from "node:crypto";
import type { Logger } from "pino";
import type { Crypto } from "./crypto.js";
import type { Store, Tenant } from "./db/store.js";
import { publicHttpsUrlError, type Resolver } from "./net.js";

export interface ReservationInput {
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
}

/** Dados pessoais guardados cifrados (AES-256-GCM) na base de dados. */
export interface ReservationPii {
  guest_name: string;
  caller_phone: string | null;
  contact_phone: string | null;
  email: string | null;
  notes: string | null;
  language: string;
}

export interface ReservationSink {
  submit(req: ReservationInput): Promise<{ request_id: string }>;
}

export interface WebhookOptions {
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
  retryDelayMs?: number;
}

/**
 * Entrega a um webhook do cliente com:
 * - HMAC-SHA256 em "X-Signature" sobre `${timestamp}.${body}` e "X-Timestamp" (anti-replay)
 * - "Idempotency-Key", timeout, 3 tentativas com backoff, sem redirects
 * - verificação anti-SSRF do destino no momento da entrega
 */
export async function deliverWebhook(
  url: string,
  secret: string,
  payload: { request_id: string } & Record<string, unknown>,
  opts: WebhookOptions = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (await publicHttpsUrlError(url, opts.resolver)) return false;
  const body = JSON.stringify(payload);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    try {
      const res = await fetchImpl(url, {
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
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return false;
    } catch {
      /* tenta outra vez */
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 250) * 2 ** attempt));
  }
  return false;
}

/**
 * Guarda o pedido na base de dados (fonte de verdade, visível no painel) e,
 * se o cliente tiver webhook, entrega-o em segundo plano. A chamada não fica
 * à espera do sistema do cliente.
 */
export class DbReservationSink implements ReservationSink {
  constructor(
    private readonly store: Store,
    private readonly crypto: Crypto,
    private readonly tenant: Tenant,
    private readonly log: Logger,
    private readonly webhookOpts: WebhookOptions = {},
  ) {}

  async submit(req: ReservationInput): Promise<{ request_id: string }> {
    const pii: ReservationPii = {
      guest_name: req.guest_name,
      caller_phone: req.caller_phone,
      contact_phone: req.contact_phone,
      email: req.email,
      notes: req.notes,
      language: req.language,
    };
    const id = await this.store.insertReservation({
      tenant_id: this.tenant.id,
      call_sid: req.call_sid,
      pii_enc: this.crypto.encrypt(JSON.stringify(pii)),
      check_in: req.check_in,
      check_out: req.check_out,
      room_type: req.room_type,
      adults: req.adults,
      children: req.children,
      quoted_total: req.quoted_total,
      currency: req.currency,
    });

    const { webhook_url, webhook_secret_enc } = this.tenant;
    if (webhook_url && webhook_secret_enc) {
      const payload = { ...req, request_id: id, created_at: new Date().toISOString(), status: "pending_confirmation" };
      void deliverWebhook(webhook_url, this.crypto.decrypt(webhook_secret_enc), payload, this.webhookOpts)
        .then(async (ok) => {
          if (ok) await this.store.markDelivered(id);
          else this.log.warn({ request_id: id }, "webhook de reservas falhou; o pedido fica no painel");
        })
        .catch((err: unknown) => this.log.error({ err: err instanceof Error ? err.message : "?" }, "erro na entrega do webhook"));
    }
    return { request_id: id };
  }
}
