import { z } from "zod";
import type { Resort, Room } from "./resort.js";
import { todayInTimezone } from "./resort.js";

export interface StayQuery {
  check_in: string; // AAAA-MM-DD
  check_out: string; // AAAA-MM-DD
  adults: number;
  children: number;
  room_type?: string | undefined;
}

export interface RoomOffer {
  room_type: string;
  name: string;
  available: boolean;
  nights: number;
  total_price: number | null;
  currency: string;
  price_is_estimate: boolean;
}

export interface AvailabilityProvider {
  check(query: StayQuery, signal?: AbortSignal): Promise<RoomOffer[]>;
}

const DAY_MS = 86_400_000;

function parseIsoDate(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  // Rejeita datas impossíveis (ex.: 2026-02-30 é normalizada pelo Date).
  if (new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t;
}

/**
 * Valida as regras de negócio de uma estadia. Devolve uma mensagem de erro
 * legível (para o modelo explicar ao cliente) ou o nº de noites.
 */
export function validateStay(
  q: StayQuery,
  resort: Resort,
  now: Date = new Date(),
): { ok: true; nights: number } | { ok: false; error: string } {
  const ci = parseIsoDate(q.check_in);
  const co = parseIsoDate(q.check_out);
  if (ci === null || co === null) return { ok: false, error: "Datas inválidas. Usa o formato AAAA-MM-DD." };

  const today = parseIsoDate(todayInTimezone(resort.timezone, now))!;
  if (ci < today) return { ok: false, error: "A data de entrada já passou." };

  const nights = Math.round((co - ci) / DAY_MS);
  const rules = resort.booking_rules;
  if (nights < 1) return { ok: false, error: "A data de saída tem de ser depois da data de entrada." };
  if (nights < rules.min_nights) return { ok: false, error: `A estadia mínima é de ${rules.min_nights} noites.` };
  if (nights > rules.max_nights) return { ok: false, error: `A estadia máxima é de ${rules.max_nights} noites.` };
  if ((ci - today) / DAY_MS > rules.max_days_in_advance) {
    return { ok: false, error: `Só aceitamos pedidos até ${rules.max_days_in_advance} dias de antecedência.` };
  }
  if (q.adults < 1) return { ok: false, error: "É necessário pelo menos um adulto." };
  if (q.room_type && !resort.rooms.some((r) => r.id === q.room_type)) {
    return { ok: false, error: "Tipo de quarto desconhecido." };
  }
  return { ok: true, nights };
}

export function roomFits(room: Room, adults: number, children: number): boolean {
  return adults <= room.max_adults && children <= room.max_children && adults + children <= room.max_occupancy;
}

/**
 * Fornecedor estático: sem ligação ao PMS. Indica os quartos compatíveis com a
 * ocupação e um preço ESTIMADO. A disponibilidade real é confirmada pela equipa.
 */
export class StaticAvailabilityProvider implements AvailabilityProvider {
  constructor(private readonly resort: Resort) {}

  async check(q: StayQuery): Promise<RoomOffer[]> {
    const nights = Math.round(
      (Date.parse(`${q.check_out}T00:00:00Z`) - Date.parse(`${q.check_in}T00:00:00Z`)) / DAY_MS,
    );
    return this.resort.rooms
      .filter((r) => !q.room_type || r.id === q.room_type)
      .filter((r) => roomFits(r, q.adults, q.children))
      .map((r) => ({
        room_type: r.id,
        name: r.name,
        available: r.units > 0,
        nights,
        total_price: Math.round(r.nightly_rate_from * nights * 100) / 100,
        currency: this.resort.currency,
        price_is_estimate: true,
      }));
  }
}

const PmsResponseSchema = z.object({
  rooms: z
    .array(
      z.object({
        room_type: z.string().max(40),
        available_units: z.number().int().min(0),
        total_price: z.number().nonnegative().nullable(),
        currency: z.string().length(3),
      }),
    )
    .max(100),
});

/**
 * Fornecedor HTTP genérico para o PMS / channel manager.
 * Contrato esperado: GET {PMS_API_URL}/availability?check_in=&check_out=&adults=&children=
 * com "Authorization: Bearer <token>" e resposta JSON validada por PmsResponseSchema.
 */
export class HttpAvailabilityProvider implements AvailabilityProvider {
  constructor(
    private readonly resort: Resort,
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 5000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async check(q: StayQuery, signal?: AbortSignal): Promise<RoomOffer[]> {
    const url = new URL(`${this.baseUrl}/availability`);
    url.searchParams.set("check_in", q.check_in);
    url.searchParams.set("check_out", q.check_out);
    url.searchParams.set("adults", String(q.adults));
    url.searchParams.set("children", String(q.children));

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`PMS respondeu ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > 512_000) throw new Error("Resposta do PMS demasiado grande");
    const data = PmsResponseSchema.parse(await res.json());

    const nights = Math.round(
      (Date.parse(`${q.check_out}T00:00:00Z`) - Date.parse(`${q.check_in}T00:00:00Z`)) / DAY_MS,
    );
    const byId = new Map(this.resort.rooms.map((r) => [r.id, r]));
    return data.rooms
      .filter((r) => byId.has(r.room_type))
      .filter((r) => !q.room_type || r.room_type === q.room_type)
      .filter((r) => roomFits(byId.get(r.room_type)!, q.adults, q.children))
      .map((r) => ({
        room_type: r.room_type,
        name: byId.get(r.room_type)!.name,
        available: r.available_units > 0,
        nights,
        total_price: r.total_price,
        currency: r.currency,
        price_is_estimate: false,
      }));
  }
}
