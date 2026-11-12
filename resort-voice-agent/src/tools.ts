import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AvailabilityProvider } from "./availability.js";
import { validateStay, roomFits } from "./availability.js";
import type { ReservationSink } from "./reservations.js";
import type { Resort } from "./resort.js";

/** Remove caracteres de controlo e normaliza espaços (defesa contra injeção em sistemas a jusante). */
const cleanText = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(max));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CheckAvailabilityInput = z
  .object({
    check_in: isoDate,
    check_out: isoDate,
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20).default(0),
    room_type: z.string().max(40).optional(),
  })
  .strict();

export const ReservationInput = z
  .object({
    guest_name: cleanText(100),
    contact_phone: z
      .string()
      .regex(/^\+?[0-9][0-9 ]{6,19}$/)
      .optional(),
    email: z.string().email().max(254).optional(),
    check_in: isoDate,
    check_out: isoDate,
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20).default(0),
    room_type: z.string().max(40),
    notes: cleanText(500).optional(),
    caller_confirmed_summary: z.literal(true),
    consent_to_contact: z.literal(true),
  })
  .strict();

export const TransferInput = z.object({ reason: cleanText(200) }).strict();
export const EndCallInput = z.object({ reason: cleanText(200).optional() }).strict();
export const SwitchLanguageInput = z.object({ language_code: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/) }).strict();

export function buildTools(resort: Resort): Anthropic.Beta.BetaTool[] {
  const roomIds = resort.rooms.map((r) => r.id);
  const langCodes = resort.languages.map((l) => l.code);
  // eager_input_streaming: os inputs chegam mais cedo no stream; por isso
  // validamos SEMPRE cada input com Zod antes de executar (ver executeTool).
  return [
    {
      name: "check_availability",
      description:
        "Verifica disponibilidade e preço para uma estadia. Usa só depois de confirmar com o cliente as datas e o número de pessoas. Datas no formato AAAA-MM-DD.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          check_in: { type: "string", description: "Data de entrada AAAA-MM-DD" },
          check_out: { type: "string", description: "Data de saída AAAA-MM-DD" },
          adults: { type: "integer", minimum: 1, maximum: 20 },
          children: { type: "integer", minimum: 0, maximum: 20 },
          room_type: { type: "string", enum: roomIds, description: "Opcional: filtra por tipo de quarto" },
        },
        required: ["check_in", "check_out", "adults"],
        additionalProperties: false,
      },
    },
    {
      name: "create_reservation_request",
      description:
        "Regista um PEDIDO de reserva (não confirmado) para a equipa de reservas tratar. Só usar depois de: verificar disponibilidade, repetir o resumo ao cliente, o cliente confirmar explicitamente, e dar consentimento para ser contactado. Pede pelo menos um contacto (telefone ou e-mail). Nunca incluir dados de pagamento.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          guest_name: { type: "string", description: "Nome completo do hóspede" },
          contact_phone: { type: "string", description: "Telefone de contacto, se diferente do número que liga" },
          email: { type: "string", description: "E-mail de contacto" },
          check_in: { type: "string" },
          check_out: { type: "string" },
          adults: { type: "integer", minimum: 1, maximum: 20 },
          children: { type: "integer", minimum: 0, maximum: 20 },
          room_type: { type: "string", enum: roomIds },
          notes: { type: "string", description: "Pedidos especiais (sem dados de saúde sensíveis nem pagamento)" },
          caller_confirmed_summary: { type: "boolean", const: true },
          consent_to_contact: { type: "boolean", const: true },
        },
        required: [
          "guest_name",
          "check_in",
          "check_out",
          "adults",
          "room_type",
          "caller_confirmed_summary",
          "consent_to_contact",
        ],
        additionalProperties: false,
      },
    },
    {
      name: "transfer_to_human",
      description:
        "Transfere a chamada para a receção. Antes de chamar, diz ao cliente que vais transferir. Usa quando o cliente pede, numa urgência, reclamação, faturação, alteração/cancelamento de reserva existente, ou quando não consegues ajudar.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { reason: { type: "string", description: "Motivo curto, sem dados pessoais" } },
        required: ["reason"],
        additionalProperties: false,
      },
    },
    {
      name: "end_call",
      description: "Termina a chamada depois de te despedires do cliente.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "switch_language",
      description: "Muda o idioma de reconhecimento de voz e de síntese de voz da chamada.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: { language_code: { type: "string", enum: langCodes } },
        required: ["language_code"],
        additionalProperties: false,
      },
      // A última ferramenta leva o breakpoint de cache: tools + system ficam em cache.
      cache_control: { type: "ephemeral" },
    },
  ];
}

export type CallAction =
  | { type: "transfer"; reason: string }
  | { type: "end"; reason: string }
  | { type: "switch_language"; code: string };

export interface ToolContext {
  resort: Resort;
  availability: AvailabilityProvider;
  reservations: ReservationSink;
  callSid: string;
  callerPhone: string | null;
  language: string;
  /** Contadores por chamada para limitar abuso. */
  counters: { availability: number; reservations: number };
  signal?: AbortSignal;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  action?: CallAction;
}

const LIMITS = { availability: 10, reservations: 2 };

function zodError(err: z.ZodError): string {
  return `Parâmetros inválidos: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
}

export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "check_availability": {
      const p = CheckAvailabilityInput.safeParse(input);
      if (!p.success) return { content: zodError(p.error), isError: true };
      if (++ctx.counters.availability > LIMITS.availability) {
        return { content: "Limite de pesquisas nesta chamada atingido. Oferece transferir para a receção.", isError: true };
      }
      const v = validateStay(p.data, ctx.resort);
      if (!v.ok) return { content: v.error, isError: true };
      try {
        const offers = await ctx.availability.check(p.data, ctx.signal);
        if (offers.length === 0) {
          return {
            content: JSON.stringify({ result: "Nenhum tipo de quarto acomoda esta ocupação ou não há disponibilidade." }),
            isError: false,
          };
        }
        return { content: JSON.stringify({ nights: v.nights, offers }), isError: false };
      } catch {
        return {
          content: "O sistema de disponibilidade não respondeu. Pede desculpa e oferece transferir para a receção.",
          isError: true,
        };
      }
    }

    case "create_reservation_request": {
      const p = ReservationInput.safeParse(input);
      if (!p.success) return { content: zodError(p.error), isError: true };
      const d = p.data;
      if (!d.contact_phone && !d.email && !ctx.callerPhone) {
        return { content: "Falta um contacto (telefone ou e-mail).", isError: true };
      }
      const v = validateStay(d, ctx.resort);
      if (!v.ok) return { content: v.error, isError: true };
      const room = ctx.resort.rooms.find((r) => r.id === d.room_type)!;
      if (!roomFits(room, d.adults, d.children)) {
        return { content: "Esse quarto não acomoda este número de pessoas.", isError: true };
      }
      if (++ctx.counters.reservations > LIMITS.reservations) {
        return { content: "Limite de pedidos nesta chamada atingido. Transfere para a receção.", isError: true };
      }
      try {
        const { request_id } = await ctx.reservations.submit({
          call_sid: ctx.callSid,
          caller_phone: ctx.callerPhone,
          guest_name: d.guest_name,
          contact_phone: d.contact_phone ?? null,
          email: d.email ?? null,
          check_in: d.check_in,
          check_out: d.check_out,
          adults: d.adults,
          children: d.children,
          room_type: d.room_type,
          quoted_total: Math.round(room.nightly_rate_from * v.nights * 100) / 100,
          currency: ctx.resort.currency,
          notes: d.notes ?? null,
          language: ctx.language,
          consent_to_contact: true,
        });
        return {
          content: JSON.stringify({
            status: "pedido_registado",
            reference: request_id.slice(0, 8).toUpperCase(),
            next_step: "A equipa de reservas confirma a disponibilidade e envia um link de pagamento seguro.",
          }),
          isError: false,
        };
      } catch {
        ctx.counters.reservations--;
        return { content: "Não foi possível registar o pedido. Pede desculpa e transfere para a receção.", isError: true };
      }
    }

    case "transfer_to_human": {
      const p = TransferInput.safeParse(input);
      const reason = p.success ? p.data.reason : "pedido do cliente";
      return { content: "A transferir a chamada.", isError: false, action: { type: "transfer", reason } };
    }

    case "end_call": {
      const p = EndCallInput.safeParse(input ?? {});
      const reason = p.success ? (p.data.reason ?? "despedida") : "despedida";
      return { content: "Chamada a terminar.", isError: false, action: { type: "end", reason } };
    }

    case "switch_language": {
      const p = SwitchLanguageInput.safeParse(input);
      if (!p.success) return { content: zodError(p.error), isError: true };
      if (!ctx.resort.languages.some((l) => l.code === p.data.language_code)) {
        return { content: "Idioma não suportado.", isError: true };
      }
      return {
        content: `Idioma alterado para ${p.data.language_code}. Responde a partir de agora nesse idioma.`,
        isError: false,
        action: { type: "switch_language", code: p.data.language_code },
      };
    }

    default:
      return { content: `Ferramenta desconhecida: ${name}`, isError: true };
  }
}
