import { z } from "zod";

/**
 * Configuração validada no arranque. Os segredos vêm SEMPRE de variáveis de
 * ambiente. As mensagens de erro nunca mostram valores.
 */
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), "tem de começar por https://")
  .transform((u) => u.replace(/\/+$/, ""));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    /** Nome comercial mostrado no site e no painel. */
    BRAND_NAME: z.string().min(1).max(40).default("Atendia"),
    /** E-mail de contacto mostrado no site e na política de privacidade. */
    CONTACT_EMAIL: z.string().email().optional(),

    /** URL público HTTPS do serviço (sem barra final). */
    PUBLIC_BASE_URL: httpsUrl,

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "tem de ser um URL postgres://"),
    DATABASE_SSL: bool.default(false),

    /** 64 caracteres hex (openssl rand -hex 32). Cifra dados pessoais e segredos em repouso. */
    MASTER_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 caracteres hexadecimais"),
    /** Segredo para assinar os tokens de sessão por chamada (>= 32 caracteres). */
    SESSION_SIGNING_SECRET: z.string().min(32),

    /** Conta de administrador da plataforma, criada no primeiro arranque. */
    ADMIN_EMAIL: z.string().email(),
    ADMIN_INITIAL_PASSWORD: z.string().min(12).optional(),

    ANTHROPIC_API_KEY: z.string().min(20),
    CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
    CLAUDE_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
    CLAUDE_REFUSAL_FALLBACK: bool.default(true),

    TWILIO_AUTH_TOKEN: z.string().min(16),
    TWILIO_VALIDATE_SIGNATURE: bool.default(true),

    /** Limite global de chamadas simultâneas nesta instância. */
    MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(1000).default(50),
    MAX_CALL_DURATION_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    MAX_TURNS_PER_CALL: z.coerce.number().int().min(5).max(200).default(60),
    MAX_UTTERANCE_CHARS: z.coerce.number().int().min(100).max(5000).default(1500),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(30000),

    /** RGPD: dias até os dados pessoais dos pedidos de reserva serem apagados. */
    RETENTION_DAYS: z.coerce.number().int().min(7).max(730).default(90),

    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  })
  .superRefine((env, ctx) => {
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
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}
