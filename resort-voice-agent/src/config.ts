import { z } from "zod";

/**
 * Configuração validada no arranque. Se faltar algo obrigatório ou um valor
 * for inválido, o processo termina antes de aceitar qualquer chamada.
 * Os segredos vêm SEMPRE de variáveis de ambiente (nunca do código).
 */
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), "tem de começar por https://")
  .transform((u) => u.replace(/\/+$/, ""));

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "formato E.164, ex.: +351210000000");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    /** URL público HTTPS onde o serviço está exposto (sem barra final). */
    PUBLIC_BASE_URL: httpsUrl,

    ANTHROPIC_API_KEY: z.string().min(20),
    CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
    /** Nível de esforço do modelo. "low" = menor latência ao telefone. */
    CLAUDE_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
    /** Fallback do lado do servidor quando o modelo recusa um pedido. */
    CLAUDE_REFUSAL_FALLBACK: bool.default(true),

    TWILIO_AUTH_TOKEN: z.string().min(16),
    /** Desligar apenas em testes locais. Em produção é obrigatório. */
    TWILIO_VALIDATE_SIGNATURE: bool.default(true),

    /** Segredo para assinar os tokens de sessão por chamada (>= 32 caracteres). */
    SESSION_SIGNING_SECRET: z.string().min(32),

    /** Número da receção para transferir chamadas para um humano. */
    RECEPTION_PHONE_NUMBER: e164,

    RESORT_CONFIG_PATH: z.string().default("config/resort.json"),

    /** Fornecedor de disponibilidade: "static" (ficheiro) ou "http" (API do PMS). */
    AVAILABILITY_PROVIDER: z.enum(["static", "http"]).default("static"),
    PMS_API_URL: httpsUrl.optional(),
    PMS_API_TOKEN: z.string().min(8).optional(),

    /** Destino dos pedidos de reserva (CRM, n8n, PMS...). Assinado com HMAC. */
    RESERVATION_WEBHOOK_URL: httpsUrl.optional(),
    RESERVATION_WEBHOOK_SECRET: z.string().min(32).optional(),

    MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(1000).default(20),
    MAX_CALL_DURATION_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    MAX_TURNS_PER_CALL: z.coerce.number().int().min(5).max(200).default(60),
    MAX_UTTERANCE_CHARS: z.coerce.number().int().min(100).max(5000).default(1500),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(30000),

    /** Atrás de um proxy/load balancer (Render, Fly, Cloud Run...) usar "1". */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  })
  .superRefine((env, ctx) => {
    if (env.AVAILABILITY_PROVIDER === "http" && (!env.PMS_API_URL || !env.PMS_API_TOKEN)) {
      ctx.addIssue({
        code: "custom",
        path: ["PMS_API_URL"],
        message: "AVAILABILITY_PROVIDER=http exige PMS_API_URL e PMS_API_TOKEN",
      });
    }
    if (env.RESERVATION_WEBHOOK_URL && !env.RESERVATION_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["RESERVATION_WEBHOOK_SECRET"],
        message: "RESERVATION_WEBHOOK_URL exige RESERVATION_WEBHOOK_SECRET",
      });
    }
    if (env.NODE_ENV === "production" && !env.TWILIO_VALIDATE_SIGNATURE) {
      ctx.addIssue({
        code: "custom",
        path: ["TWILIO_VALIDATE_SIGNATURE"],
        message: "a validação de assinatura Twilio não pode ser desligada em produção",
      });
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Nunca imprimir valores: só os nomes das variáveis e o motivo.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}
