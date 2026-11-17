import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import type Anthropic from "@anthropic-ai/sdk";
import type { StreamFactory, StreamParams, TurnStream } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { Crypto, hashPassword } from "../src/crypto.js";
import { PgDb } from "../src/db/driver.js";
import { Store } from "../src/db/store.js";
import { ResortSchema, newTenantProfile, type Resort } from "../src/resort.js";
import { createApp } from "../src/server.js";

export const silentLog = pino({ level: "silent" });
export const DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/voice_test";

export function testResort(): Resort {
  return ResortSchema.parse(JSON.parse(readFileSync("config/resort.example.json", "utf8")));
}

export const TEST_ENV = {
  NODE_ENV: "test",
  PUBLIC_BASE_URL: "https://voice.example.test",
  DATABASE_URL: DB_URL,
  MASTER_ENCRYPTION_KEY: "ab".repeat(32),
  SESSION_SIGNING_SECRET: "x".repeat(40),
  ADMIN_EMAIL: "admin@example.test",
  ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-test-auth-token-123456",
};
export const BASE = TEST_ENV.PUBLIC_BASE_URL;

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ ...TEST_ENV, ...overrides } as NodeJS.ProcessEnv);
}
export const testCrypto = () => new Crypto(TEST_ENV.MASTER_ENCRYPTION_KEY);

/** Base de dados limpa, com o esquema migrado. */
export async function freshStore(): Promise<Store> {
  const store = new Store(new PgDb(DB_URL, false));
  await store.db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await store.migrate();
  return store;
}

export const ADMIN_PASSWORD = "admin-password-123";
export const OWNER_PASSWORD = "owner-password-123";

export async function seedAdmin(store: Store): Promise<void> {
  await store.ensureAdmin(TEST_ENV.ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD));
  const u = await store.userByEmail(TEST_ENV.ADMIN_EMAIL);
  await store.setPassword(u!.id, await hashPassword(ADMIN_PASSWORD), false);
}

/** Cria um resort ativo com número, receção e dono com a palavra-passe já definida. */
export async function seedTenant(store: Store, name: string, email: string, number: string | null): Promise<string> {
  const id = await store.createTenantWithOwner(name, newTenantProfile(testResort(), name), email, await hashPassword(OWNER_PASSWORD));
  const owner = await store.ownerOf(id);
  await store.setPassword(owner!.id, await hashPassword(OWNER_PASSWORD), false);
  await store.updateTenantAdmin(id, { status: "active", twilio_number: number, max_concurrent_calls: 5, monthly_minutes_limit: 500 });
  await store.updateReception(id, "+351210000000");
  return id;
}

export async function startApp(store: Store, replies: ScriptedReply[] = [], overrides: Record<string, string> = {}) {
  const stream = scriptedStream(replies);
  const app = createApp({
    config: testConfig(overrides),
    store,
    crypto: testCrypto(),
    stream,
    resortTemplate: testResort(),
    log: silentLog,
    webhookOpts: { resolver: async () => ["93.184.216.34"], retryDelayMs: 1, fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch },
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const port = (app.server.address() as AddressInfo).port;
  return { port, stream, app };
}

/** Cliente HTTP mínimo com cookie de sessão e token CSRF, como um browser. */
export class Browser {
  cookie = "";
  constructor(private readonly port: number) {}

  async get(path: string) {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, { redirect: "manual", headers: this.cookie ? { cookie: this.cookie } : {} });
    return { status: res.status, location: res.headers.get("location"), body: await res.text(), headers: res.headers };
  }
  async post(path: string, fields: Record<string, string | string[]>, opts: { origin?: string | null; csrf?: string | false } = {}) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    if (opts.csrf !== false && this.cookie) body.set("_csrf", opts.csrf ?? (await this.csrf()));
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, { method: "POST", redirect: "manual", headers, body: body.toString() });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    return { status: res.status, location: res.headers.get("location"), body: await res.text(), setCookie: set };
  }
  async csrf(): Promise<string> {
    const page = await this.get("/conta");
    const m = /name="_csrf" value="([^"]+)"/.exec(page.body);
    if (!m) throw new Error("sem token CSRF na página");
    return m[1]!;
  }
  async login(email: string, password: string) {
    return this.post("/login", { email, password });
  }
}

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

/** Resposta simulada do modelo para uma ronda. */
export interface ScriptedReply {
  blocks: Block[];
  stop_reason?: Anthropic.Beta.BetaMessage["stop_reason"];
  delayMs?: number;
}

/** Fábrica de streams que devolve respostas pré-definidas, por ordem. */
export function scriptedStream(replies: ScriptedReply[]): StreamFactory & { calls: StreamParams[] } {
  const calls: StreamParams[] = [];
  const factory = ((params: StreamParams): TurnStream => {
    calls.push(structuredClone(params));
    const reply = replies.shift();
    if (!reply) throw new Error("sem mais respostas simuladas");
    const listeners: Array<(d: string) => void> = [];
    let aborted = false;
    return {
      on(_event: "text", cb: (d: string) => void) {
        listeners.push(cb);
        return this;
      },
      abort() {
        aborted = true;
      },
      async finalMessage() {
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (aborted) throw new Error("aborted");
        for (const b of reply.blocks) if (b.type === "text") for (const l of listeners) l(b.text);
        const hasTool = reply.blocks.some((b) => b.type === "tool_use");
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "test",
          content: reply.blocks,
          stop_reason: reply.stop_reason ?? (hasTool ? "tool_use" : "end_turn"),
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Beta.BetaMessage;
      },
    };
  }) as StreamFactory & { calls: StreamParams[] };
  factory.calls = calls;
  return factory;
}

/** Data AAAA-MM-DD daqui a N dias (UTC). */
export function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 4000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout à espera da condição");
}
