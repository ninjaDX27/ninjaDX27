import { createHash } from "node:crypto";
import { pino, type Logger } from "pino";

/**
 * Logger estruturado com redação de dados pessoais (RGPD).
 * - Nunca registamos transcrições, nomes, e-mails nem números completos.
 * - O número do cliente é registado apenas como hash truncado (pseudonimização).
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "resort-voice-agent" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-twilio-signature"]',
        "*.guest_name",
        "*.email",
        "*.phone",
        "*.voicePrompt",
        "*.utterance",
        "*.notes",
        "*.from",
        "*.to",
        "*.apiKey",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  });
}

export function pseudonymize(value: string | undefined): string {
  if (!value) return "unknown";
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
