import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/**
 * Chaves derivadas (HKDF) de uma única MASTER_ENCRYPTION_KEY:
 * - "enc": AES-256-GCM para dados pessoais e segredos dos clientes em repouso
 * - "pid": HMAC para pseudonimizar números de telefone (não reversível sem a chave)
 */
export class Crypto {
  private readonly encKey: Buffer;
  private readonly pidKey: Buffer;

  constructor(masterKeyHex: string) {
    const master = Buffer.from(masterKeyHex, "hex");
    if (master.length !== 32) throw new Error("MASTER_ENCRYPTION_KEY tem de ter 64 caracteres hexadecimais");
    this.encKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "voice-agent/enc/v1", 32));
    this.pidKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "voice-agent/pid/v1", 32));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.encKey, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
  }

  decrypt(token: string): string {
    const [v, iv, tag, ct] = token.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("formato cifrado inválido");
    const d = createDecipheriv("aes-256-gcm", this.encKey, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  }

  pseudonymize(value: string | null | undefined): string {
    if (!value) return "unknown";
    return createHmac("sha256", this.pidKey).update(value).digest("hex").slice(0, 24);
  }
}

// ---------- Passwords (scrypt, parâmetros guardados com o hash) ----------

const SCRYPT = { N: 32768, r: 8, p: 1, len: 64 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, "base64");
  const N = Number(n);
  const got = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 128 * N * Number(r) * 2,
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Hash constante para igualar tempos quando o utilizador não existe. */
export const DUMMY_PASSWORD_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export function passwordPolicyError(pw: string): string | null {
  if (pw.length < 12) return "A palavra-passe tem de ter pelo menos 12 caracteres.";
  if (pw.length > 200) return "A palavra-passe é demasiado longa.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Use letras e números.";
  return null;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Palavra-passe temporária legível (sem caracteres ambíguos). */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(18);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out.replace(/(.{6})(?=.)/g, "$1-") + "7";
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
