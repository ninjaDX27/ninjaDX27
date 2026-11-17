import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Proteção SSRF: os clientes configuram URLs (webhook, PMS) que o servidor
 * chama. Só aceitamos HTTPS para endereços públicos; redes privadas, loopback,
 * link-local (metadados da cloud) e afins são recusados.
 */
function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number) as [number, number, number, number];
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 192 && p[1] === 0) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19))
  );
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) {
    const a = ip.toLowerCase();
    if (a === "::" || a === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateV4(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a) || a.startsWith("::ffff:") || a.startsWith("64:ff9b:");
  }
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Devolve null se o URL for aceitável, ou uma mensagem de erro. */
export async function publicHttpsUrlError(raw: string, resolve: Resolver = defaultResolver): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "URL inválido.";
  }
  if (url.protocol !== "https:") return "O URL tem de começar por https://.";
  if (url.username || url.password) return "O URL não pode conter credenciais.";
  if (url.port && url.port !== "443") return "Só é permitida a porta 443.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host) ? "Endereço não permitido." : null;
  if (!host.includes(".") || /\.(local|internal|localhost)$/i.test(host)) return "Endereço não permitido.";
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return "Não foi possível resolver o domínio.";
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) return "Endereço não permitido.";
  return null;
}
