/**
 * Versão para PC (Windows/macOS/Linux): um só executável, base de dados embutida
 * (PGlite), painel em http://localhost, abre o browser automaticamente.
 * Pensada para demonstrações e testes. Para clientes reais use o deploy no servidor.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicStreamFactory } from "./agent.js";
import { loadConfig } from "./config.js";
import { Crypto, hashPassword, temporaryPassword } from "./crypto.js";
import { PgliteDb } from "./db/driver.js";
import { Store } from "./db/store.js";
import { createLogger } from "./logger.js";
import { ResortSchema, newTenantProfile } from "./resort.js";
import { createApp } from "./server.js";

const BRAND = "Atendia";
const ADMIN_EMAIL = "admin@atendia.local";
const DEMO_EMAIL = "demo@atendia.local";

interface Settings {
  masterKey: string;
  sessionSecret: string;
  anthropicKey?: string;
  port?: number;
  /** Opcional: chamadas reais pelo Twilio, através de um túnel HTTPS (cloudflared). */
  twilioAuthToken?: string;
}

// ---------------------------------------------------------------- Recursos embutidos

/** Dentro do executável (Node SEA) os ficheiros vêm embutidos; em desenvolvimento, do disco. */
function seaApi(): { isSea(): boolean; getAsset(key: string): ArrayBuffer } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require("node:sea") as { isSea(): boolean; getAsset(key: string): ArrayBuffer };
    return sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}
const sea = seaApi();
const DEV_FILES: Record<string, string> = {
  "styles.css": "public/styles.css",
  "app.js": "public/app.js",
  "test-call.js": "public/test-call.js",
  "resort.example.json": "config/resort.example.json",
};
function asset(name: string): Buffer {
  if (sea) return Buffer.from(sea.getAsset(name));
  return readFileSync(DEV_FILES[name]!);
}

async function pgliteOptions(): Promise<PGliteOptions> {
  if (!sea) return {};
  return {
    pgliteWasmModule: await WebAssembly.compile(sea.getAsset("pglite.wasm")),
    initdbWasmModule: await WebAssembly.compile(sea.getAsset("initdb.wasm")),
    fsBundle: new Blob([sea.getAsset("pglite.data")]),
  };
}

// ---------------------------------------------------------------- Utilitários

function appHome(): string {
  if (process.env.ATENDIA_HOME) return process.env.ATENDIA_HOME;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), BRAND);
  return join(homedir(), ".atendia");
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: as permissões do perfil do utilizador já protegem a pasta */
  }
}

async function freePort(start: number): Promise<number> {
  for (let port = start; port < start + 20; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = createServer()
        .once("error", () => resolve(false))
        .once("listening", () => srv.close(() => resolve(true)))
        .listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  throw new Error(`Não há portas livres entre ${start} e ${start + 19}.`);
}

function openBrowser(url: string): void {
  if (process.env.ATENDIA_NO_BROWSER) return;
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* sem browser: o endereço fica no ecrã */
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Abre um túnel HTTPS temporário (trycloudflare.com) para o Twilio chegar a este PC. */
async function startTunnel(port: number): Promise<{ url: string; child: ChildProcess } | null> {
  const exe = join(dirname(process.execPath), process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (!existsSync(exe)) return null;
  const child = spawn(exe, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { windowsHide: true });
  const url = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 45_000);
    const onData = (d: Buffer) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", () => resolve(null));
  });
  if (!url) {
    child.kill();
    return null;
  }
  return { url, child };
}

// ---------------------------------------------------------------- Arranque

async function main(): Promise<void> {
  const home = appHome();
  mkdirSync(home, { recursive: true });
  const settingsPath = join(home, "definicoes.json");

  let settings: Settings;
  const firstRun = !existsSync(settingsPath);
  if (firstRun) {
    settings = { masterKey: randomBytes(32).toString("hex"), sessionSecret: randomBytes(32).toString("hex") };
  } else {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
  }

  console.log(`\n  ${BRAND}: assistente telefónico com IA para resorts (versão para PC)\n`);

  const anthropicKey = process.env.ANTHROPIC_API_KEY || settings.anthropicKey;
  if (!anthropicKey) {
    if (!process.stdin.isTTY) throw new Error(`Falta a chave da Anthropic. Escreva-a em "anthropicKey" no ficheiro ${settingsPath}.`);
    console.log("  Precisa de uma chave da API da Anthropic (console.anthropic.com → API keys).");
    console.log("  Fica guardada só neste computador, em:", settingsPath, "\n");
    let key = "";
    while (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
      key = await ask("  Cole a chave e carregue em Enter: ");
      if (!/^sk-ant-/.test(key)) console.log("  A chave começa por sk-ant-. Tente outra vez.");
    }
    settings.anthropicKey = key;
  }
  writePrivate(settingsPath, JSON.stringify(settings, null, 2));

  // Ficheiros do site, extraídos dos recursos embutidos.
  const publicDir = join(home, "public");
  mkdirSync(publicDir, { recursive: true });
  for (const f of ["styles.css", "app.js", "test-call.js"]) writeFileSync(join(publicDir, f), asset(f));
  const resortTemplate = ResortSchema.parse(JSON.parse(asset("resort.example.json").toString("utf8")));

  const port = await freePort(settings.port ?? 8080);
  const localUrl = `http://localhost:${port}`;

  let tunnel: Awaited<ReturnType<typeof startTunnel>> = null;
  if (settings.twilioAuthToken) {
    console.log("  A abrir o túnel HTTPS para o Twilio…");
    tunnel = await startTunnel(port);
    if (!tunnel) console.log("  Não foi possível abrir o túnel (falta o cloudflared junto ao programa?). Chamadas reais desligadas.\n");
  }

  const config = loadConfig({
    NODE_ENV: "production",
    DESKTOP_MODE: "true",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    BRAND_NAME: BRAND,
    PORT: String(port),
    PUBLIC_BASE_URL: tunnel?.url ?? localUrl,
    EXTRA_ORIGINS: `${localUrl},http://127.0.0.1:${port}`,
    MASTER_ENCRYPTION_KEY: settings.masterKey,
    SESSION_SIGNING_SECRET: settings.sessionSecret,
    ADMIN_EMAIL,
    ANTHROPIC_API_KEY: anthropicKey ?? settings.anthropicKey!,
    ...(tunnel && settings.twilioAuthToken ? { TWILIO_AUTH_TOKEN: settings.twilioAuthToken, TRUST_PROXY: "1" } : { TRUST_PROXY: "0" }),
    MAX_CONCURRENT_CALLS: "5",
  } as NodeJS.ProcessEnv);
  const log = createLogger(config.LOG_LEVEL);

  console.log("  A preparar a base de dados…");
  const pglite = await PGlite.create(join(home, "dados"), await pgliteOptions());
  const store = new Store(new PgliteDb(pglite));
  await store.migrate();

  // Primeira execução: administrador + resort de demonstração.
  if (!(await store.adminExists())) {
    const adminPw = temporaryPassword();
    const demoPw = temporaryPassword();
    await store.ensureAdmin(ADMIN_EMAIL, await hashPassword(adminPw));
    const tenantId = await store.createTenantWithOwner("Resort Demonstração", newTenantProfile(resortTemplate, "Resort Demonstração"), DEMO_EMAIL, await hashPassword(demoPw));
    await store.updateTenantAdmin(tenantId, { status: "active", twilio_number: null, max_concurrent_calls: 3, monthly_minutes_limit: 600 });
    const text = [
      `${BRAND}: acessos iniciais (palavras-passe temporárias, alteração obrigatória no primeiro acesso)`,
      "",
      `Painel do resort:   ${DEMO_EMAIL}   ${demoPw}`,
      `Administração:      ${ADMIN_EMAIL}  ${adminPw}`,
      "",
      "Depois de alterar as palavras-passe, apague este ficheiro.",
    ].join("\r\n");
    writePrivate(join(home, "ACESSOS.txt"), text);
    console.log("\n  Acessos criados (guardados também em", join(home, "ACESSOS.txt") + "):");
    console.log(`    Painel do resort:  ${DEMO_EMAIL}  /  ${demoPw}`);
    console.log(`    Administração:     ${ADMIN_EMAIL}  /  ${adminPw}\n`);
  }

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 1, timeout: config.LLM_TIMEOUT_MS });
  const { server, shutdown } = createApp({ config, store, crypto: new Crypto(config.MASTER_ENCRYPTION_KEY), stream: anthropicStreamFactory(anthropic), resortTemplate, log, publicDir });

  // Só aceita ligações deste computador.
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  console.log(`  Pronto. Painel: ${localUrl}/login`);
  console.log(`  Teste de voz: entre no painel do resort e abra “Testar o assistente” (Chrome ou Edge).`);
  if (tunnel) {
    console.log(`\n  Chamadas reais: no Twilio, no número, em “A call comes in” → Webhook POST:`);
    console.log(`    ${tunnel.url}/voice`);
    console.log("  Este endereço muda sempre que o programa reinicia.");
  }
  console.log("\n  Para fechar, feche esta janela ou carregue em Ctrl+C.\n");
  openBrowser(`${localUrl}/login`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    tunnel?.child.kill();
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    shutdown()
      .then(() => store.close())
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

main().catch(async (err: unknown) => {
  console.error("\n  Erro ao arrancar:", err instanceof Error ? err.message : String(err));
  // Num duplo clique a janela fecharia logo: espera por Enter para se poder ler o erro.
  if (process.stdin.isTTY) await ask("\n  Carregue em Enter para fechar.").catch(() => undefined);
  process.exit(1);
});
