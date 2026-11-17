// Gera o executável da versão para PC (Node.js Single Executable Application).
// Uso: node scripts/build-desktop.mjs [win|linux|mac] [--with-cloudflared]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const target = process.argv[2] ?? (process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux");
const withTunnel = process.argv.includes("--with-cloudflared");
const version = process.version; // o binário de destino tem de ser a MESMA versão do Node que gera o blob
const out = join("build", "desktop", target);
const cache = join("build", "cache");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
async function download(url, dest) {
  if (existsSync(dest)) return readFileSync(dest);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download falhou (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf;
}

// 1) Um só ficheiro CommonJS com todo o código (requisito do Node SEA).
await build({
  entryPoints: ["src/desktop.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(out, "atendia.cjs"),
  logLevel: "warning",
  // Algumas dependências (PGlite) usam import.meta.url, que não existe em CommonJS.
  banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__importMetaUrl" },
  legalComments: "none",
});

// 2) Blob SEA com o código e os recursos (base de dados WASM, CSS/JS do site, perfil de exemplo).
const pg = "node_modules/@electric-sql/pglite/dist";
const seaConfig = {
  main: join(out, "atendia.cjs"),
  output: join(out, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false, // false = o blob funciona noutro sistema operativo
  assets: {
    "pglite.wasm": `${pg}/pglite.wasm`,
    "initdb.wasm": `${pg}/initdb.wasm`,
    "pglite.data": `${pg}/pglite.data`,
    "styles.css": "public/styles.css",
    "app.js": "public/app.js",
    "test-call.js": "public/test-call.js",
    "resort.example.json": "config/resort.example.json",
  },
};
writeFileSync(join(out, "sea-config.json"), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", join(out, "sea-config.json")], { stdio: "inherit" });

// 3) Binário oficial do Node.js, verificado contra o SHASUMS256 publicado.
let base;
let exeName;
if (target === "win") {
  const file = `node-${version}-win-x64.exe`;
  const sums = (await download(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, join(cache, `SHASUMS256-${version}.txt`))).toString();
  const expected = /^([0-9a-f]{64})\s+win-x64\/node\.exe$/m.exec(sums)?.[1];
  const buf = await download(`https://nodejs.org/dist/${version}/win-x64/node.exe`, join(cache, file));
  if (!expected || sha256(buf) !== expected) throw new Error("checksum do node.exe não confere");
  base = join(cache, file);
  exeName = "Atendia.exe";
} else {
  base = process.execPath;
  exeName = "atendia";
}
const exe = join(out, exeName);
if (target === "win") {
  // A assinatura do node.exe deixa de ser válida depois da injeção: remove-se primeiro.
  try {
    execFileSync("osslsigncode", ["remove-signature", "-in", base, "-out", exe], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("signtool", ["remove", "/s", base], { stdio: "ignore" });
    } catch {
      console.warn("aviso: não foi possível remover a assinatura (instale osslsigncode ou signtool)");
    }
    copyFileSync(base, exe);
  }
} else {
  copyFileSync(base, exe);
}
chmodSync(exe, 0o755);

// 4) Injeta o blob no binário.
const postjectArgs = [exe, "NODE_SEA_BLOB", join(out, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (target === "mac") postjectArgs.push("--macho-segment-name", "NODE_SEA");
execFileSync(process.execPath, ["node_modules/postject/dist/cli.js", ...postjectArgs], { stdio: "inherit" });

// 5) Opcional: cloudflared para o túnel HTTPS (chamadas reais pelo Twilio).
if (withTunnel && target === "win") {
  const buf = await download("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe", join(cache, "cloudflared.exe"));
  writeFileSync(join(out, "cloudflared.exe"), buf);
  console.log("cloudflared.exe sha256:", sha256(buf));
}

writeFileSync(
  join(out, "LEIA-ME.txt"),
  readFileSync("docs/LEIA-ME-PC.txt", "utf8").replace(/\r?\n/g, "\r\n"),
);
for (const f of ["atendia.cjs", "sea-prep.blob", "sea-config.json"]) rmSync(join(out, f));
console.log(`\nPronto: ${exe}  (${(readFileSync(exe).length / 1e6).toFixed(0)} MB)`);
