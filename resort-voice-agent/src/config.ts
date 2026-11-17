import { z } from "zod";

/**
 * Configuração validada no arranque. Os segredos vêm SEMPRE de variáveis de
 * ambiente. As mensagens de erro nunca mostram valores.
 */
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    /** Nome comercial mostrado no site e no painel. */
    BRAND_NAME: z.string().min(1).max(40).default("Atendia"),
    /** E-mail de contacto mostrado no site e na política de privacidade. */
    CONTACT_EMAIL: z.string().email().optional(),

    /** Versão para PC: base de dados embutida, acesso só em localhost. */
    DESKTOP_MODE: bool.default(false),

    /** URL público HTTPS do serviço (sem barra final). Na versão PC pode ser http://localhost. */
    PUBLIC_BASE_URL: z
      .string()
      .url()
      .transform((u) => u.replace(/\/+$/, "")),
    /** Origens adicionais aceites nos formulários (ex.: http://localhost:8080 na versão PC com túnel). */
    EXTRA_ORIGINS: z
      .string()
      .default("")
      .transform((s) => s.split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean)),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "tem de ser um URL postgres://").optional(),
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

    /** Opcional só na versão PC (sem Twilio, usa-se a chamada de teste no browser). */
    TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
    TWILIO_VALIDATE_SIGNATURE: bool.default(true),

    /** Voz própria: Asterisk (SIP) + serviço de voz (Whisper/Piper), em alternativa ao Twilio. */
    ASTERISK_ENABLED: bool.default(false),
    /** Segredo partilhado com o dialplan do Asterisk (>= 32 caracteres). */
    ASTERISK_SECRET: z.string().min(32).optional(),
    AUDIOSOCKET_HOST: z.string().default("127.0.0.1"),
    AUDIOSOCKET_PORT: z.coerce.number().int().min(1).max(65535).default(9092),
    SPEECH_URL: z.string().url().default("http://127.0.0.1:8000"),
    SPEECH_TOKEN: z.string().min(16).optional(),
    /** Anti-fraude: só se transfere para números com estes prefixos (fixos e móveis PT por omissão). */
    TRANSFER_ALLOWED_PREFIXES: z
      .string()
      .default("+3512,+3519")
      .transform((s) => s.split(",").map((x) => x.trim()).filter((x) => /^\+\d{1,6}$/.test(x))),
    VAD_SILENCE_MS: z.coerce.number().int().min(300).max(3000).default(700),

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
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.PUBLIC_BASE_URL);
    if (!env.PUBLIC_BASE_URL.startsWith("https://") && !(env.DESKTOP_MODE && local)) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "tem de começar por https://" });
    }
    if (!env.DESKTOP_MODE && !env.DATABASE_URL) {
      ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "obrigatório" });
    }
    if (env.ASTERISK_ENABLED && !env.ASTERISK_SECRET) {
      ctx.addIssue({ code: "custom", path: ["ASTERISK_SECRET"], message: "obrigatório com ASTERISK_ENABLED" });
    }
    if (!env.DESKTOP_MODE && !env.ASTERISK_ENABLED && !env.TWILIO_AUTH_TOKEN) {
      ctx.addIssue({ code: "custom", path: ["TWILIO_AUTH_TOKEN"], message: "obrigatório" });
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
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}
