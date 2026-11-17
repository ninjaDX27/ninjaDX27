import type { Logger } from "pino";
import type { WebSocket } from "ws";
import { z } from "zod";
import { CallAgent, type AgentOptions } from "./agent.js";
import type { AvailabilityProvider } from "./availability.js";
import type { ReservationSink } from "./reservations.js";
import type { CallAction } from "./tools.js";

/** Mensagens que o Twilio ConversationRelay envia (validadas; o resto é ignorado). */
const Inbound = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("setup"),
    callSid: z.string(),
    from: z.string().optional(),
    to: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("prompt"),
    voicePrompt: z.string(),
    lang: z.string().optional(),
    last: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("interrupt"),
    utteranceUntilInterrupt: z.string().optional(),
  }).passthrough(),
  z.object({ type: z.literal("dtmf"), digit: z.string() }).passthrough(),
  z.object({ type: z.literal("error"), description: z.string().optional() }).passthrough(),
]);

export interface SessionDeps {
  agentOptions: AgentOptions;
  availability: AvailabilityProvider;
  reservations: ReservationSink;
  expectedCallSid: string;
  maxTurns: number;
  maxUtteranceChars: number;
  maxCallDurationMs: number;
  log: Logger;
  onClose: (stats: SessionStats) => void;
}

export interface SessionStats {
  turns: number;
  outcome: "transfer" | "end" | "hangup";
  language: string;
}

/** Remove formatação que soaria mal em voz (markdown, emojis). */
export function sanitizeForSpeech(s: string): string {
  return s
    .replace(/[*_#`>|~]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "");
}

/**
 * Uma sessão por chamada (um WebSocket do ConversationRelay).
 * - Processa uma fala de cada vez; uma nova fala ou interrupção aborta o turno em curso.
 * - Aplica limites de duração, nº de turnos e tamanho das falas.
 */
export class CallSession {
  private agent: CallAgent | null = null;
  private language: string;
  private current: AbortController | null = null;
  private chain: Promise<void> = Promise.resolve();
  private interruptedNote: string | null = null;
  private ended = false;
  private outcome: SessionStats["outcome"] = "hangup";
  private readonly durationTimer: NodeJS.Timeout;
  private readonly log: Logger;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: SessionDeps,
  ) {
    this.language = deps.agentOptions.resort.languages[0]!.code;
    this.log = deps.log;
    this.durationTimer = setTimeout(() => this.onMaxDuration(), deps.maxCallDurationMs);
    this.durationTimer.unref();

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return this.close(1003, "binary not supported");
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return this.close(1007, "invalid json");
      }
      const parsed = Inbound.safeParse(json);
      if (!parsed.success) return; // tipos desconhecidos/novos são ignorados
      this.handle(parsed.data);
    });
    ws.on("close", () => this.dispose());
    ws.on("error", (err) => this.log.warn({ err: err.message }, "erro no websocket"));
  }

  private handle(msg: z.infer<typeof Inbound>): void {
    switch (msg.type) {
      case "setup": {
        if (this.agent) return; // setup duplicado
        if (msg.callSid !== this.deps.expectedCallSid) {
          this.log.warn("CallSid do setup não corresponde ao token de sessão");
          return this.close(1008, "call mismatch");
        }
        this.agent = new CallAgent(this.deps.agentOptions, {
          resort: this.deps.agentOptions.resort,
          availability: this.deps.availability,
          reservations: this.deps.reservations,
          callSid: msg.callSid,
          callerPhone: msg.from && /^\+[1-9]\d{6,14}$/.test(msg.from) ? msg.from : null,
          language: this.language,
          counters: { availability: 0, reservations: 0 },
        });
        this.log.info("sessão iniciada");
        return;
      }
      case "prompt": {
        if (!this.agent || this.ended) return;
        if (msg.last === false) return; // ignorar transcrições parciais
        const text = msg.voicePrompt.trim().slice(0, this.deps.maxUtteranceChars);
        if (!text) return;
        if (this.agent.turns >= this.deps.maxTurns) {
          this.log.warn("limite de turnos atingido");
          this.speak("Para o ajudar melhor, vou transferi-lo para a receção.", true);
          return this.finish({ type: "transfer", reason: "limite de turnos" });
        }
        this.enqueue(text);
        return;
      }
      case "interrupt": {
        this.current?.abort();
        if (msg.utteranceUntilInterrupt) {
          this.interruptedNote = msg.utteranceUntilInterrupt.slice(0, 500);
        }
        return;
      }
      case "dtmf": {
        if (msg.digit === "0" && this.agent && !this.ended) {
          this.current?.abort();
          this.speak("Vou transferi-lo para a receção.", true);
          this.finish({ type: "transfer", reason: "tecla 0" });
        }
        return;
      }
      case "error": {
        this.log.warn({ description: msg.description }, "erro reportado pelo ConversationRelay");
        return;
      }
    }
  }

  private enqueue(text: string): void {
    // Nova fala do cliente: abortar a resposta em curso e processar por ordem.
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    this.chain = this.chain.then(() => this.runTurn(text, controller)).catch((err: unknown) => {
      this.log.error({ err: err instanceof Error ? err.message : "?" }, "falha no turno");
    });
  }

  private async runTurn(text: string, controller: AbortController): Promise<void> {
    if (controller.signal.aborted || !this.agent || this.ended) return;
    let userText = text;
    if (this.interruptedNote) {
      userText = `[Nota do sistema: a tua resposta anterior foi interrompida pelo cliente depois de dizeres: "${this.interruptedNote}"]\n${text}`;
      this.interruptedNote = null;
    }
    let pendingTerminal: CallAction | null = null;
    await this.agent.runTurn(
      userText,
      {
        onText: (delta) => this.speak(delta, false),
        onAction: (action) => {
          if (action.type === "switch_language") {
            this.language = action.code;
            this.send({ type: "language", ttsLanguage: action.code, transcriptionLanguage: action.code });
          } else {
            pendingTerminal = action;
          }
        },
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    this.speak("", true); // fecha a resposta (last: true)
    if (pendingTerminal) this.finish(pendingTerminal);
  }

  private speak(token: string, last: boolean): void {
    this.send({ type: "text", token: sanitizeForSpeech(token), last });
  }

  private finish(action: CallAction): void {
    if (this.ended) return;
    this.ended = true;
    this.outcome = action.type === "transfer" ? "transfer" : "end";
    const handoff = JSON.stringify({
      action: action.type === "transfer" ? "transfer" : "end",
      reason: action.type === "switch_language" ? "" : action.reason.slice(0, 200),
      language: this.language,
    });
    this.log.info({ action: action.type }, "a terminar sessão");
    this.send({ type: "end", handoffData: handoff });
  }

  private onMaxDuration(): void {
    if (this.ended) return;
    this.log.warn("duração máxima da chamada atingida");
    this.current?.abort();
    this.speak("Atingimos o tempo máximo desta chamada. Vou transferi-lo para a receção.", true);
    this.finish({ type: "transfer", reason: "duração máxima" });
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  private disposed = false;
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.durationTimer);
    this.current?.abort();
    this.deps.onClose({ turns: this.agent?.turns ?? 0, outcome: this.outcome, language: this.language });
    this.log.info("sessão terminada");
  }
}
