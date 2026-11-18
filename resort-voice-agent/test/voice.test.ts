import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { Store } from "../src/db/store.js";
import { createApp, normalizeDid } from "../src/server.js";
import { FRAME_BYTES, FrameParser, KIND, encodeFrame } from "../src/voice/audiosocket.js";
import type { SpeechClient } from "../src/voice/speech-client.js";
import { freshStore, scriptedStream, seedTenant, silentLog, testConfig, testCrypto, testResort, waitFor, type ScriptedReply } from "./helpers.js";

const SECRET = "s".repeat(40);
const NUMBER = "+351300000001";

let store: Store;
let tenant: string;
let app: ReturnType<typeof createApp> | null = null;

beforeAll(async () => {
  store = await freshStore();
});
afterAll(async () => {
  await store.close();
});
beforeEach(async () => {
  await store.db.query("TRUNCATE tenants, users, web_sessions, calls, reservation_requests, leads, audit_log CASCADE");
  tenant = await seedTenant(store, "Resort Voz", "voz@example.test", NUMBER);
});
afterEach(async () => {
  await app?.shutdown();
  app = null;
});

/** Serviço de voz simulado: o texto "falado" é o número de blocos de áudio recebidos. */
function fakeSpeech(transcripts: string[]) {
  const spoken: string[] = [];
  const vocab: string[] = [];
  const client: SpeechClient = {
    async stt(_pcm, _rate, _lang, vocabulary) {
      vocab.push(vocabulary ?? "");
      return { text: transcripts.shift() ?? "", language: "pt", probability: 0.99 };
    },
    async tts(text) {
      spoken.push(text);
      return Buffer.alloc(FRAME_BYTES * 5, 1); // 100 ms de "voz"
    },
  };
  return { client, spoken, vocab };
}

async function start(replies: ScriptedReply[], transcripts: string[]) {
  const speech = fakeSpeech(transcripts);
  const created = createApp({
    config: testConfig({ ASTERISK_ENABLED: "true", ASTERISK_SECRET: SECRET, VAD_SILENCE_MS: "300" }),
    store,
    crypto: testCrypto(),
    stream: scriptedStream(replies),
    resortTemplate: testResort(),
    log: silentLog,
    speech: speech.client,
  });
  app = created;
  await new Promise<void>((r) => created.server.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => created.audioServer!.listen(0, "127.0.0.1", () => r()));
  return {
    http: (created.server.address() as AddressInfo).port,
    audio: (created.audioServer!.address() as AddressInfo).port,
    spoken: speech.spoken,
    vocab: speech.vocab,
  };
}

const get = async (port: number, path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).text();

/** Simula o Asterisk: envia o UUID, áudio e recebe áudio. */
function asterisk(port: number, uuid: string) {
  return new Promise<{ sock: Socket; audioFrames: () => number; closed: Promise<void> }>((resolve) => {
    const sock = connect(port, "127.0.0.1");
    const parser = new FrameParser();
    let frames = 0;
    const closed = new Promise<void>((r) => sock.on("close", () => r()));
    sock.on("data", (d) => {
      for (const f of parser.push(d)) if (f.kind === KIND.AUDIO) frames++;
    });
    sock.on("connect", () => {
      sock.write(encodeFrame(KIND.UUID, Buffer.from(uuid.replace(/-/g, ""), "hex")));
      resolve({ sock, audioFrames: () => frames, closed });
    });
  });
}

/** Envia "fala" (tom alto) seguida de silêncio, em blocos de 20 ms. */
async function speak(sock: Socket, ms = 600, silenceMs = 500) {
  const loud = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 2; i++) loud.writeInt16LE(Math.round(8000 * Math.sin(i / 3)), i * 2);
  for (let t = 0; t < ms; t += 20) sock.write(encodeFrame(KIND.AUDIO, loud));
  for (let t = 0; t < silenceMs; t += 20) sock.write(encodeFrame(KIND.AUDIO, Buffer.alloc(FRAME_BYTES)));
}

describe("Asterisk: números e endpoints do dialplan", () => {
  it("normaliza números de operadores SIP", () => {
    expect(normalizeDid("300000001")).toBe("+351300000001");
    expect(normalizeDid("351300000001")).toBe("+351300000001");
    expect(normalizeDid("00351300000001")).toBe("+351300000001");
    expect(normalizeDid("+351 300 000 001")).toBe("+351300000001");
    expect(normalizeDid("abc")).toBeNull();
  });

  it("exige o segredo partilhado e valida o pedido", async () => {
    const { http } = await start([], []);
    const uuid = randomUUID();
    expect(await (await fetch(`http://127.0.0.1:${http}/asterisk/start?uuid=${uuid}&did=300000001`)).status).toBe(403);
    expect(await get(http, `/asterisk/start?key=${"x".repeat(40)}&uuid=${uuid}&did=300000001`)).toBe("forbidden");
    expect(await get(http, `/asterisk/start?key=${SECRET}&uuid=nao-e-uuid&did=300000001`)).toBe("reject");
    expect(await get(http, `/asterisk/start?key=${SECRET}&uuid=${uuid}&did=300000099`)).toBe("reject");
    expect(await get(http, `/asterisk/start?key=${SECRET}&uuid=${uuid}&did=300000001&from=%2B351910000000`)).toBe("ok");
  });

  it("acima do limite de minutos, encaminha para a receção (só números PT permitidos)", async () => {
    const { http } = await start([], []);
    await store.updateTenantAdmin(tenant, { status: "active", twilio_number: NUMBER, max_concurrent_calls: 5, monthly_minutes_limit: 0 });
    expect(await get(http, `/asterisk/start?key=${SECRET}&uuid=${randomUUID()}&did=300000001`)).toBe("transfer:+351210000000");
    await store.updateReception(tenant, "+882123456789"); // número internacional de valor acrescentado
    expect(await get(http, `/asterisk/start?key=${SECRET}&uuid=${randomUUID()}&did=300000001`)).toBe("reject");
  });

  it("AudioSocket recusa chamadas não registadas", async () => {
    const { audio } = await start([], []);
    const { closed } = await asterisk(audio, randomUUID());
    await closed;
  });
});

describe("Asterisk: conversa por voz", () => {
  it("saudação, fala, transcrição, resposta falada e transferência", async () => {
    const { http, audio, spoken, vocab } = await start(
      [
        { blocks: [{ type: "text", text: "Temos sim. O quarto duplo custa cento e vinte euros por noite." }] },
        { blocks: [{ type: "text", text: "Vou transferir." }, { type: "tool_use", id: "t1", name: "transfer_to_human", input: { reason: "pedido" } }] },
      ],
      ["Têm quartos livres?", "Quero falar com a receção."],
    );
    const uuid = randomUUID();
    expect(await get(http, `/asterisk/start?key=${SECRET}&uuid=${uuid}&did=300000001&from=%2B351910000000`)).toBe("ok");
    const { sock, audioFrames, closed } = await asterisk(audio, uuid);

    await waitFor(() => spoken[0]); // saudação
    expect(spoken[0]).toContain("Resort Voz");
    await waitFor(() => (audioFrames() >= 5 ? true : undefined));

    await speak(sock);
    await waitFor(() => spoken.find((t) => t.includes("cento e vinte")));
    expect(spoken).toContain("Temos sim.");
    expect(vocab[0]).toContain("Resort Voz");
    expect(vocab[0]).toContain("Quarto Duplo Vista Mar");
    expect(spoken).toContain("O quarto duplo custa cento e vinte euros por noite.");

    await speak(sock);
    await closed; // a ponte devolve a chamada ao Asterisk
    expect(await get(http, `/asterisk/handoff?key=${SECRET}&uuid=${uuid}`)).toBe("transfer:+351210000000");
    expect(await get(http, `/asterisk/handoff?key=${SECRET}&uuid=${uuid}`)).toBe("end"); // uso único

    const call = await waitFor(async () => (await store.listCalls(tenant)).find((c) => c.outcome !== null));
    expect(call).toMatchObject({ outcome: "transfer", turns: 2 });
    expect(call.caller_hash).not.toContain("910000000");
  });

  it("ruído baixo e frases-fantasma do Whisper não chegam ao agente", async () => {
    const { http, audio, spoken } = await start([{ blocks: [{ type: "text", text: "Diga." }] }], ["Obrigado.", "Olá?"]);
    const uuid = randomUUID();
    await get(http, `/asterisk/start?key=${SECRET}&uuid=${uuid}&did=300000001`);
    const { sock } = await asterisk(audio, uuid);
    await waitFor(() => spoken[0]);
    // ruído de fundo fraco: não é fala
    const noise = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_BYTES / 2; i++) noise.writeInt16LE(Math.round((Math.random() - 0.5) * 200), i * 2);
    for (let i = 0; i < 50; i++) sock.write(encodeFrame(KIND.AUDIO, noise));
    await new Promise((r) => setTimeout(r, 300));
    await speak(sock); // transcrito como "Obrigado." -> descartado
    await speak(sock); // "Olá?" -> chega ao agente
    await waitFor(() => spoken.find((t) => t === "Diga."));
    sock.destroy();
  });

  it("fecha a fala mesmo quando deixam de chegar blocos de áudio (supressão de silêncio)", async () => {
    const { http, audio, spoken } = await start([{ blocks: [{ type: "text", text: "Temos piscina." }] }], ["Têm piscina?"]);
    const uuid = randomUUID();
    await get(http, `/asterisk/start?key=${SECRET}&uuid=${uuid}&did=300000001`);
    const { sock } = await asterisk(audio, uuid);
    await waitFor(() => spoken[0]);
    await speak(sock, 600, 0); // só voz, depois nada
    await waitFor(() => spoken.find((t) => t === "Temos piscina."));
    sock.destroy();
  });

  it("o hóspede pode interromper o assistente", async () => {
    const { http, audio, spoken } = await start(
      [
        { blocks: [{ type: "text", text: "Esta é uma resposta muito longa que vai ser interrompida." }], delayMs: 50 },
        { blocks: [{ type: "text", text: "Claro, diga." }] },
      ],
      ["Têm piscina?", "Espere, outra pergunta."],
    );
    const uuid = randomUUID();
    await get(http, `/asterisk/start?key=${SECRET}&uuid=${uuid}&did=300000001`);
    const { sock } = await asterisk(audio, uuid);
    await waitFor(() => spoken[0]);
    await speak(sock);
    await waitFor(() => spoken.find((t) => t.includes("interrompida")));
    await speak(sock, 800); // fala por cima da resposta
    await waitFor(() => spoken.find((t) => t === "Claro, diga."));
    sock.destroy();
  });
});
