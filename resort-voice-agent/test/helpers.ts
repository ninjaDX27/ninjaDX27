import { readFileSync } from "node:fs";
import { pino } from "pino";
import type Anthropic from "@anthropic-ai/sdk";
import type { StreamFactory, StreamParams, TurnStream } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { ResortSchema, type Resort } from "../src/resort.js";

export const silentLog = pino({ level: "silent" });

export function testResort(): Resort {
  return ResortSchema.parse(JSON.parse(readFileSync("config/resort.example.json", "utf8")));
}

export const TEST_ENV = {
  NODE_ENV: "test",
  PUBLIC_BASE_URL: "https://voice.example.test",
  ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-test-auth-token-123456",
  SESSION_SIGNING_SECRET: "x".repeat(40),
  RECEPTION_PHONE_NUMBER: "+351210000000",
  RESORT_CONFIG_PATH: "config/resort.example.json",
};

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ ...TEST_ENV, ...overrides } as NodeJS.ProcessEnv);
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

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
