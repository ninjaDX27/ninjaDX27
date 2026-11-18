import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { Logger } from "pino";
import { FRAME_BYTES, FRAME_MS, FrameParser, KIND, SAMPLE_RATE, encodeFrame, rms, uuidFromBytes } from "./audiosocket.js";
import type { SpeechClient } from "./speech-client.js";

/**
 * Ponte entre uma chamada do Asterisk (áudio) e a CallSession (texto).
 *
 * A CallSession fala o protocolo do Twilio ConversationRelay (setup / prompt /
 * interrupt / dtmf -> text / language / end). Esta ponte faz o papel do
 * ConversationRelay: deteta a fala (VAD), transcreve (Whisper), sintetiza as
 * respostas (Piper) e toca-as ao ritmo certo, com interrupção pelo hóspede.
 */

export interface PendingCall {
  callSid: string;
  tenantId: string;
  from: string | null;
  language: string;
  greeting: string;
}

export interface VadOptions {
  /** Silêncio que fecha uma fala. */
  silenceMs: number;
  /** Duração mínima de voz para contar como fala. */
  minSpeechMs: number;
  /** Corta falas muito longas. */
  maxUtteranceMs: number;
  /** Energia mínima (RMS) para considerar voz. */
  minThreshold: number;
}

export const DEFAULT_VAD: VadOptions = { silenceMs: 700, minSpeechMs: 250, maxUtteranceMs: 15_000, minThreshold: 400 };

export interface BridgeOptions {
  /** Devolve (e consome) a chamada registada pelo dialplan, ou null. */
  claim(uuid: string): PendingCall | null;
  /** Arranca a CallSession com o socket falso. Devolve false se não for possível. */
  start(ws: RelaySocket, call: PendingCall): Promise<boolean>;
  /** Guarda o resultado para o dialplan (transferir ou desligar). */
  handoff(uuid: string, data: { action: string; language: string }): void;
  speech: SpeechClient;
  vad?: VadOptions;
  log: Logger;
}

/** Frases que o Whisper "ouve" no silêncio ou no ruído: descartam-se. */
const HALLUCINATIONS = [
  /^(obrigad[oa]|thank you|thanks|gracias|merci|danke)[.!]*$/i,
  /amara\.org|legendas|subt[ií]tulos|subtitles|untertitel|sous-titres/i,
  /^[.…\s-]*$/,
];

/**
 * Faz de WebSocket para a CallSession: o que ela envia (send) vai para a ponte;
 * o que a ponte quer dizer-lhe chega por eventos "message".
 */
export class RelaySocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  constructor(private readonly onSend: (data: string) => void, private readonly onClose: () => void) {
    super();
  }
  send(data: string): void {
    if (this.readyState === 1) this.onSend(data);
  }
  close(): void {
    this.onClose();
  }
  terminate(): void {
    this.onClose();
  }
  ping(): void {}
  deliver(msg: Record<string, unknown>): void {
    if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
  markClosed(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }
}

export class VoiceBridge {
  private readonly parser = new FrameParser();
  private readonly vad: VadOptions;
  private ws: RelaySocket | null = null;
  private uuid: string | null = null;
  private lang = "pt-PT";
  private closed = false;
  private ending = false;

  // Reprodução
  private queue: Buffer[] = [];
  private queueOffset = 0;
  private playTimer: NodeJS.Timeout | null = null;
  private idleWaiters: Array<() => void> = [];

  // Síntese: cada interrupção cria uma nova "geração" e descarta o áudio antigo.
  private generation = 0;
  private ttsChain: Promise<void> = Promise.resolve();
  private pendingText = "";
  private spokenText = "";
  private agentBusy = false;

  // Deteção de fala
  private speaking = false;
  private voicedFrames = 0;
  private silentFrames = 0;
  private startCandidates = 0;
  private noiseFloor = 150;
  private utterance: Buffer[] = [];
  private preRoll: Buffer[] = [];
  private sttChain: Promise<void> = Promise.resolve();
  /** Fecha a fala quando deixa de chegar áudio (o Asterisk e muitos operadores não enviam silêncio). */
  private silenceTimer: NodeJS.Timeout | null = null;
  private readonly uuidTimer: NodeJS.Timeout;

  constructor(
    private readonly socket: Socket,
    private readonly opts: BridgeOptions,
  ) {
    this.vad = opts.vad ?? DEFAULT_VAD;
    socket.setNoDelay(true);
    this.uuidTimer = setTimeout(() => this.close("sem identificação"), 5000);
    socket.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = this.parser.push(chunk);
      } catch (err) {
        return this.close((err as Error).message);
      }
      for (const f of frames) this.onFrame(f.kind, f.payload);
    });
    socket.on("close", () => this.close("socket fechado"));
    socket.on("error", (err) => this.opts.log.warn({ err: err.message }, "erro no AudioSocket"));
  }

  // ------------------------------------------------------------ Entrada

  private onFrame(kind: number, payload: Buffer): void {
    if (this.closed) return;
    if (!this.ws) {
      if (kind !== KIND.UUID) return this.close("primeira mensagem não é o UUID");
      return this.onUuid(payload);
    }
    switch (kind) {
      case KIND.AUDIO:
        return this.onAudio(payload);
      case KIND.DTMF:
        return this.ws.deliver({ type: "dtmf", digit: payload.toString("ascii").slice(0, 1) });
      case KIND.HANGUP:
        return this.close("o hóspede desligou");
      case KIND.ERROR:
        this.opts.log.warn("o Asterisk reportou um erro no AudioSocket");
        return;
    }
  }

  private onUuid(payload: Buffer): void {
    clearTimeout(this.uuidTimer);
    const uuid = uuidFromBytes(payload);
    const call = uuid ? this.opts.claim(uuid) : null;
    if (!uuid || !call) return this.close("chamada desconhecida");
    this.uuid = uuid;
    this.lang = call.language;
    this.ws = new RelaySocket(
      (data) => this.onAgentMessage(data),
      () => this.close("sessão terminada"),
    );
    const ws = this.ws;
    // A sessão tem de estar a ouvir antes de receber o "setup" (o resort é carregado da base de dados).
    this.opts
      .start(ws, call)
      .then((ok) => {
        if (!ok) return this.close("cliente indisponível");
        if (this.closed) return;
        ws.deliver({ type: "setup", callSid: call.callSid, from: call.from ?? undefined });
        this.say(call.greeting);
      })
      .catch(() => this.close("erro ao iniciar a sessão"));
  }

  private onAudio(frame: Buffer): void {
    const level = rms(frame);
    const playing = this.isPlaying();
    // Durante a reprodução exige-se mais energia e mais tempo, para o eco da nossa voz não contar.
    const threshold = Math.max(this.vad.minThreshold, this.noiseFloor * 3) * (playing ? 2 : 1);
    const confirmFrames = playing ? 10 : 3;

    if (!this.speaking) {
      this.preRoll.push(frame);
      if (this.preRoll.length > 15) this.preRoll.shift();
      if (level > threshold) {
        if (++this.startCandidates >= confirmFrames) this.onSpeechStart();
      } else {
        this.startCandidates = 0;
        this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
      }
      return;
    }

    this.utterance.push(frame);
    this.armSilenceTimer();
    if (level > threshold * 0.6) {
      this.voicedFrames++;
      this.silentFrames = 0;
    } else {
      this.silentFrames++;
    }
    const total = this.utterance.length * FRAME_MS;
    if (this.silentFrames * FRAME_MS >= this.vad.silenceMs || total >= this.vad.maxUtteranceMs) this.onSpeechEnd();
  }

  private armSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.speaking && !this.closed) this.onSpeechEnd();
    }, this.vad.silenceMs);
  }

  private onSpeechStart(): void {
    this.armSilenceTimer();
    this.speaking = true;
    this.startCandidates = 0;
    this.silentFrames = 0;
    this.voicedFrames = this.preRoll.length;
    this.utterance = [...this.preRoll];
    this.preRoll = [];
    if (this.isPlaying() || this.agentBusy) this.bargeIn();
  }

  private onSpeechEnd(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    const audio = Buffer.concat(this.utterance);
    const voicedMs = this.voicedFrames * FRAME_MS;
    this.speaking = false;
    this.utterance = [];
    this.voicedFrames = 0;
    this.silentFrames = 0;
    if (voicedMs < this.vad.minSpeechMs || this.ending) return;
    this.sttChain = this.sttChain.then(() => this.transcribe(audio)).catch((err: unknown) => {
      this.opts.log.error({ err: err instanceof Error ? err.message : "?" }, "falha na transcrição");
    });
  }

  private async transcribe(audio: Buffer): Promise<void> {
    if (this.closed) return;
    const current = this.lang.slice(0, 2);
    // Deteção automática do idioma; se for incerta e diferente do atual, repete no idioma atual.
    let res = await this.opts.speech.stt(audio, SAMPLE_RATE, null);
    if (res.language !== current && res.probability < 0.8) res = await this.opts.speech.stt(audio, SAMPLE_RATE, current);
    const text = res.text.trim();
    if (text.length < 2 || HALLUCINATIONS.some((re) => re.test(text)) || this.closed) return;
    this.agentBusy = true;
    this.pendingText = "";
    this.spokenText = "";
    this.ws?.deliver({ type: "prompt", voicePrompt: text, last: true, lang: res.language });
  }

  private bargeIn(): void {
    this.generation++;
    this.clearPlayback();
    this.ttsChain = Promise.resolve();
    this.pendingText = "";
    this.agentBusy = false;
    this.ws?.deliver({ type: "interrupt", utteranceUntilInterrupt: this.spokenText.trim().slice(-500) });
  }

  // ------------------------------------------------------------ Saída (respostas do agente)

  private onAgentMessage(data: string): void {
    let msg: { type?: string; token?: string; last?: boolean; ttsLanguage?: string; handoffData?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "text") {
      this.pendingText += msg.token ?? "";
      this.flushSentences(msg.last === true);
      if (msg.last) this.agentBusy = false;
    } else if (msg.type === "language" && msg.ttsLanguage) {
      this.lang = msg.ttsLanguage;
    } else if (msg.type === "end") {
      this.flushSentences(true);
      void this.finish(msg.handoffData ?? "{}");
    }
  }

  /** Envia para síntese as frases completas (ou tudo, no fim da resposta). */
  private flushSentences(all: boolean): void {
    const re = /^([\s\S]*?[.!?…:;])(\s+)/;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.pendingText))) {
      this.say(m[1]!);
      this.pendingText = this.pendingText.slice(m[0].length);
    }
    // Frase longa sem pontuação: corta numa vírgula para começar a falar mais cedo.
    if (this.pendingText.length > 180) {
      const cut = this.pendingText.lastIndexOf(", ");
      if (cut > 40) {
        this.say(this.pendingText.slice(0, cut + 1));
        this.pendingText = this.pendingText.slice(cut + 2);
      }
    }
    if (all && this.pendingText.trim()) {
      this.say(this.pendingText);
      this.pendingText = "";
    }
  }

  private say(text: string): void {
    const clean = text.trim();
    if (!clean || this.closed) return;
    const gen = this.generation;
    const lang = this.lang;
    this.ttsChain = this.ttsChain
      .then(async () => {
        if (gen !== this.generation || this.closed) return;
        const pcm = await this.opts.speech.tts(clean, lang, SAMPLE_RATE);
        if (gen !== this.generation || this.closed) return;
        this.spokenText += `${clean} `;
        this.enqueue(pcm);
      })
      .catch((err: unknown) => {
        this.opts.log.error({ err: err instanceof Error ? err.message : "?" }, "falha na síntese de voz");
      });
  }

  private async finish(handoffData: string): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    let data: { action?: string; language?: string } = {};
    try {
      data = JSON.parse(handoffData);
    } catch {
      data = {};
    }
    // Deixa terminar a última frase (no máximo 25 s) antes de devolver a chamada ao Asterisk.
    await Promise.race([this.ttsChain.then(() => this.whenIdle()), new Promise((r) => setTimeout(r, 25_000))]);
    if (this.uuid) this.opts.handoff(this.uuid, { action: data.action === "transfer" ? "transfer" : "end", language: data.language ?? this.lang });
    this.close("fim da conversa");
  }

  // ------------------------------------------------------------ Reprodução a 20 ms por bloco

  private enqueue(pcm: Buffer): void {
    if (pcm.length === 0) return;
    this.queue.push(pcm);
    if (!this.playTimer) {
      this.playTimer = setInterval(() => this.tick(), FRAME_MS);
      this.tick();
    }
  }

  private tick(): void {
    if (this.closed) return;
    const head = this.queue[0];
    if (!head) {
      if (this.playTimer) clearInterval(this.playTimer);
      this.playTimer = null;
      for (const w of this.idleWaiters.splice(0)) w();
      return;
    }
    let frame = head.subarray(this.queueOffset, this.queueOffset + FRAME_BYTES);
    this.queueOffset += FRAME_BYTES;
    if (this.queueOffset >= head.length) {
      this.queue.shift();
      this.queueOffset = 0;
    }
    if (frame.length < FRAME_BYTES) frame = Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
    this.socket.write(encodeFrame(KIND.AUDIO, frame));
  }

  private isPlaying(): boolean {
    return this.queue.length > 0;
  }

  private clearPlayback(): void {
    this.queue = [];
    this.queueOffset = 0;
  }

  private whenIdle(): Promise<void> {
    if (!this.isPlaying()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // ------------------------------------------------------------ Fim

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.uuidTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
    for (const w of this.idleWaiters.splice(0)) w();
    this.opts.log.debug({ reason }, "AudioSocket terminado");
    try {
      if (!this.socket.destroyed) this.socket.end(encodeFrame(KIND.HANGUP));
    } catch {
      /* socket já fechado */
    }
    this.ws?.markClosed();
  }
}
