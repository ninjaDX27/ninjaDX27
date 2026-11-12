# Agente de voz com IA para resorts

Assistente telefónico 24/7 para hotéis e resorts. Atende em português de Portugal (e em inglês, espanhol e francês), responde a perguntas, verifica disponibilidade, regista pedidos de reserva e transfere para a receção quando é preciso.

**Stack:** Node.js 22 + TypeScript, [Twilio ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay) para a voz (reconhecimento, síntese e interrupções), Claude (`claude-opus-5-5`) para a conversa, e Docker para o deploy.

```
Cliente ──telefone──▶ Twilio ──POST /voice (assinado)──▶ este serviço ──▶ TwiML <ConversationRelay>
                        │                                      ▲
                        └──── WebSocket wss://…/relay/<token> ─┘  ◀── texto ⇄ Claude (streaming + ferramentas)
                                                               │
                         POST /handoff ◀── fim da sessão ──────┘  ──▶ <Dial> receção  |  <Hangup>
```

## O que o agente faz

| Ferramenta | O que faz |
|---|---|
| `check_availability` | Preço e disponibilidade a partir do ficheiro do resort (`static`, preços indicativos) ou da API do PMS (`http`) |
| `create_reservation_request` | Regista um **pedido** (não uma reserva confirmada) e envia-o para o seu CRM, n8n ou PMS por webhook assinado |
| `transfer_to_human` | Transfere a chamada para a receção (`RECEPTION_PHONE_NUMBER`) |
| `end_call` | Despede-se e desliga |
| `switch_language` | Muda o reconhecimento e a voz para outro idioma configurado |

O cliente também pode carregar na **tecla 0** para falar com a receção a qualquer momento.

## Segurança incluída

| Área | Medida |
|---|---|
| Autenticidade | Valida `X-Twilio-Signature` em `/voice`, `/handoff` e no upgrade do WebSocket. Em produção, a validação não pode ser desligada (o arranque falha). |
| Sessões | Token HMAC por chamada, de uso único, com validade de 2 min, no caminho do WebSocket. O `CallSid` do `setup` tem de corresponder ao token. |
| Pagamentos (PCI) | O agente nunca pede nem aceita dados de cartão, IBAN ou documentos. O pagamento é feito por link seguro enviado pela equipa. |
| Ações com efeito | A reserva fica sempre como pedido pendente e exige confirmação e consentimento explícitos (`const: true`, validados no servidor). Há limites por chamada: 10 pesquisas e 2 pedidos. |
| Prompt injection | As regras estão fixas no prompt de sistema. Todos os inputs das ferramentas são validados com Zod (`.strict()`, enums, intervalos, datas reais) e os textos livres são limpos de caracteres de controlo e `<>`. O modelo não tem acesso a segredos nem a dados de outros hóspedes. |
| RGPD | A saudação diz que o atendente é IA e que a chamada não é gravada. As transcrições não são guardadas (só existem em memória durante a chamada). Os logs não têm dados pessoais: o número do cliente fica como hash, com redação automática de nome, e-mail, telefone e falas. O consentimento fica registado no pedido. |
| Webhooks de saída | HMAC-SHA256 sobre `timestamp.body`, `Idempotency-Key`, timeout, 3 tentativas e `redirect: "error"`. |
| PMS | Bearer token, timeout de 5 s, resposta validada por esquema, tamanho limitado e sem redirects. |
| Abuso e DoS | Rate limit HTTP, limite de chamadas simultâneas (acima dele a chamada vai para a receção), duração máxima, nº máximo de turnos, tamanho máximo das falas, `maxPayload` de 64 KB e 50 mensagens/s por WebSocket, e heartbeat. |
| Falhas | Se o modelo falhar, recusar ou exceder o tempo, ou se a sessão cair, o cliente é transferido para a receção e nunca fica abandonado. Há fallback do lado do servidor em caso de recusa do modelo (`server-side-fallback`). |
| HTTP | `helmet` (cabeçalhos de segurança, CSP `default-src 'none'`), sem `x-powered-by`, limites de body e timeouts. |
| Configuração | Tudo é validado no arranque com Zod. As mensagens de erro nunca mostram os valores dos segredos. |
| Contentor | Imagem distroless, utilizador `nonroot`, filesystem só de leitura, `cap_drop: ALL`, `no-new-privileges`, limites de memória e PIDs. |

## 1. Configurar o resort

```bash
cp config/resort.example.json config/resort.json
```

Edite `config/resort.json` com os quartos, preços, políticas, FAQ e saudações. O agente **só** responde com o que está neste ficheiro. Mantenha nas saudações a indicação de que o atendente é IA (transparência exigida pelo AI Act da UE). Se quiser escolher vozes específicas, defina `voice` em cada idioma, usando a lista de vozes do Twilio ConversationRelay.

## 2. Variáveis de ambiente

```bash
cp .env.example .env
```

Gere os segredos com:

```bash
openssl rand -hex 32
```

As variáveis obrigatórias são `PUBLIC_BASE_URL`, `ANTHROPIC_API_KEY`, `TWILIO_AUTH_TOKEN`, `SESSION_SIGNING_SECRET` e `RECEPTION_PHONE_NUMBER`. Para os pedidos de reserva chegarem a algum lado, configure também `RESERVATION_WEBHOOK_URL` e `RESERVATION_WEBHOOK_SECRET`.

> `PUBLIC_BASE_URL` tem de ser **exatamente** o URL HTTPS que o Twilio chama. Caso contrário, a validação de assinatura falha e devolve 403.

## 3. Deploy

O serviço precisa de HTTPS público com suporte a WebSockets.

**Docker (VPS com Caddy ou Nginx à frente):**

```bash
docker compose up -d --build
```

O `docker-compose.yml` expõe a porta 8080 só em `127.0.0.1`. Use um reverse proxy com TLS à frente. O Caddy faz isto numa linha: `voice.seudominio.pt { reverse_proxy 127.0.0.1:8080 }`.

**PaaS (Render, Railway, Fly.io, Cloud Run):** use o `Dockerfile` e defina as variáveis de ambiente no painel. Monte o `config/resort.json` como ficheiro ou secret, ou inclua-o na imagem. Health check: `GET /healthz`. Em Cloud Run, aumente o request timeout para 3600 s (para os WebSockets).

## 4. Ligar ao Twilio

1. Compre ou porte um número português no Twilio Console.
2. Ative as funcionalidades de IA na conta, se pedido. O ConversationRelay exige aceitar os termos de *Predictive and Generative AI* no Console.
3. No número, em **Voice Configuration**, escolha **A call comes in** → Webhook → `POST https://voice.seudominio.pt/voice`.
4. Ligue para o número e teste.

## 5. Receber os pedidos de reserva (verificar a assinatura)

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(rawBody, headers, secret) {
  const ts = headers["x-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // anti-replay
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const given = String(headers["x-signature"] ?? "");
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

Use o cabeçalho `Idempotency-Key` para ignorar entregas duplicadas.

## 6. Ligar ao PMS (opcional)

Com `AVAILABILITY_PROVIDER=http`, o serviço chama:

```
GET {PMS_API_URL}/availability?check_in=AAAA-MM-DD&check_out=AAAA-MM-DD&adults=2&children=0
Authorization: Bearer {PMS_API_TOKEN}

→ { "rooms": [ { "room_type": "duplo_mar", "available_units": 3, "total_price": 480, "currency": "EUR" } ] }
```

Os `room_type` têm de corresponder aos `id` do `resort.json`. Se o seu PMS tiver outro formato, crie um pequeno adaptador (por exemplo, em n8n) que devolva este contrato.

## Desenvolvimento

```bash
npm ci
npm run check   # typecheck + 34 testes (sem rede: Twilio e Claude simulados)
npm run dev     # com .env carregado; use um túnel HTTPS (ex.: cloudflared) e defina PUBLIC_BASE_URL
```

## Custos e latência

- O modelo predefinido é `claude-opus-5-5` com `effort: low`, para dar respostas rápidas ao telefone. O prompt de sistema e as ferramentas ficam em cache (prompt caching), o que reduz o custo dos turnos seguintes.
- As respostas são enviadas ao Twilio token a token, por isso a voz começa antes de a resposta estar completa.
- Se quiser menos custo ou latência, pode testar `CLAUDE_MODEL=claude-sonnet-5-5` e comparar a qualidade com chamadas reais.

## Antes de ir para produção

- [ ] Rever o `resort.json` (preços, políticas) e as saudações em todos os idiomas.
- [ ] Configurar o webhook de reservas e confirmar que os pedidos chegam.
- [ ] Fazer chamadas de teste em cada idioma: reserva, FAQ, transferência, tecla 0 e pedido fora de âmbito.
- [ ] Validar com o DPO/jurídico o texto de transparência (RGPD e AI Act) e a política de privacidade.
- [ ] Monitorizar os logs (`assinatura Twilio inválida`, `erro no modelo`, `capacidade máxima`).
- [ ] Definir alertas de custo na Anthropic Console e no Twilio.
