import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import type { Resort } from "./resort.js";
import { buildSystemPrompt, todayInTimezone } from "./resort.js";
import type { CallAction, ToolContext } from "./tools.js";
import { buildTools, executeTool } from "./tools.js";

type Msg = Anthropic.Beta.BetaMessage;
type MsgParam = Anthropic.Beta.BetaMessageParam;
export type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** Interface mínima do stream (permite testes sem rede). */
export interface TurnStream {
  on(event: "text", cb: (delta: string) => void): unknown;
  finalMessage(): Promise<Msg>;
  abort(): void;
}
export type StreamFactory = (params: StreamParams) => TurnStream;

export function anthropicStreamFactory(client: Anthropic): StreamFactory {
  return (params) => client.beta.messages.stream(params);
}

export interface AgentOptions {
  resort: Resort;
  model: string;
  effort: "low" | "medium" | "high";
  refusalFallback: boolean;
  timeoutMs: number;
  stream: StreamFactory;
  log: Logger;
}

export interface TurnCallbacks {
  onText(delta: string): void;
  onAction(action: CallAction): void;
}

const MAX_TOOL_ROUNDS = 6;
const SAFE_APOLOGY =
  "Peço desculpa, não consigo ajudar com isso. Posso transferi-lo para a receção, se preferir.";
const ERROR_APOLOGY =
  "Peço desculpa, estou com uma dificuldade técnica. Vou transferi-lo para a receção.";

/**
 * Um agente por chamada. O histórico só é atualizado quando um turno termina
 * com sucesso (transação): se o cliente interromper, o turno é abortado e o
 * histórico fica consistente (sem tool_use sem resposta).
 */
export class CallAgent {
  private history: MsgParam[] = [];
  private readonly systemStable: string;
  private readonly tools: Anthropic.Beta.BetaTool[];

  constructor(
    private readonly opts: AgentOptions,
    private readonly toolCtx: ToolContext,
  ) {
    this.systemStable = buildSystemPrompt(opts.resort);
    this.tools = buildTools(opts.resort);
  }

  get turns(): number {
    return this.history.filter((m) => m.role === "user" && typeof m.content === "string").length;
  }

  setLanguage(code: string): void {
    this.toolCtx.language = code;
  }

  private params(messages: MsgParam[]): StreamParams {
    const dynamic = `Data de hoje no resort: ${todayInTimezone(this.opts.resort.timezone)} (${this.opts.resort.timezone}). Idioma atual da chamada: ${this.toolCtx.language}.`;
    const p: StreamParams = {
      model: this.opts.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: this.opts.effort },
      system: [
        { type: "text", text: this.systemStable, cache_control: { type: "ephemeral" } },
        { type: "text", text: dynamic },
      ],
      tools: this.tools,
      messages,
    };
    if (this.opts.refusalFallback) {
      p.betas = ["server-side-fallback-2026-07-01"];
      p.fallbacks = "default";
    }
    return p;
  }

  /**
   * Executa um turno completo (pode incluir várias rondas de ferramentas).
   * O texto é emitido em streaming via onText para começar a falar mais cedo.
   */
  async runTurn(userText: string, cb: TurnCallbacks, signal: AbortSignal): Promise<void> {
    const working: MsgParam[] = [...this.history, { role: "user", content: userText }];
    const pendingActions: CallAction[] = [];
    let spokeSomething = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return;
      const stream = this.opts.stream(this.params(working));
      const onAbort = () => stream.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => stream.abort(), this.opts.timeoutMs);
      if (round > 0 && spokeSomething) cb.onText(" ");
      stream.on("text", (delta) => {
        if (signal.aborted) return;
        spokeSomething = true;
        cb.onText(delta);
      });

      let msg: Msg;
      try {
        msg = await stream.finalMessage();
      } catch (err) {
        if (signal.aborted) return; // interrupção do cliente: descartar turno
        this.opts.log.error({ err: describeError(err) }, "erro no modelo");
        cb.onText(ERROR_APOLOGY);
        cb.onAction({ type: "transfer", reason: "erro técnico do assistente" });
        return;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) return;

      if (msg.stop_reason === "refusal") {
        this.opts.log.warn({ category: msg.stop_details?.category ?? null }, "modelo recusou o pedido");
        if (!spokeSomething) cb.onText(SAFE_APOLOGY);
        working.push({ role: "assistant", content: SAFE_APOLOGY });
        break;
      }

      working.push({ role: "assistant", content: msg.content });

      const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;

      if (msg.stop_reason === "max_tokens") {
        // Input de ferramenta possivelmente truncado: nunca executar.
        this.opts.log.error("tool_use truncado por max_tokens");
        working.pop();
        if (!spokeSomething) cb.onText(ERROR_APOLOGY);
        cb.onAction({ type: "transfer", reason: "erro técnico do assistente" });
        return;
      }

      const outcomes = await Promise.all(
        toolUses.map((t) => executeTool(t.name, t.input, { ...this.toolCtx, signal })),
      );
      if (signal.aborted) return;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((t, i) => ({
        type: "tool_result",
        tool_use_id: t.id,
        content: outcomes[i]!.content,
        is_error: outcomes[i]!.isError,
      }));
      working.push({ role: "user", content: results });

      let terminal = false;
      for (const o of outcomes) {
        if (!o.action) continue;
        if (o.action.type === "switch_language") {
          this.setLanguage(o.action.code);
          cb.onAction(o.action); // aplicar já, para a resposta seguinte sair no novo idioma
        } else {
          pendingActions.push(o.action);
          terminal = true;
        }
      }
      if (terminal) break; // transferência/fim: não pedir mais texto ao modelo
      if (round === MAX_TOOL_ROUNDS - 1) {
        this.opts.log.warn("limite de rondas de ferramentas atingido");
        cb.onText(ERROR_APOLOGY);
        pendingActions.push({ type: "transfer", reason: "limite de rondas" });
      }
    }

    this.history = working;
    // Se houver transferência e fim no mesmo turno, a transferência prevalece.
    const action = pendingActions.find((a) => a.type === "transfer") ?? pendingActions[0];
    if (action) cb.onAction(action);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `APIError ${err.status ?? "?"}: ${err.name}`;
  if (err instanceof Error) return err.name;
  return "desconhecido";
}
