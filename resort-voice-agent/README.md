# Atendia

Assistente telefónico com IA para hotéis e resorts, vendido como SaaS: um só serviço atende vários resorts, cada um com o seu número, perfil, painel e limites de plano.

| Para quem | O que tem |
|---|---|
| Hóspede | Atendimento 24/7 em 5 idiomas, respostas com os dados do resort, pedido de reserva, transferência para a receção (ou tecla 0) |
| Resort (cliente) | Painel: chamadas, minutos usados, pedidos de reserva, edição de quartos, políticas, FAQ e idiomas, webhook e ligação ao PMS |
| Você (plataforma) | Administração: criar clientes, atribuir números, limites de minutos, suspender, repor acessos, pedidos de demonstração do site |
| Público | Site de vendas com formulário de demonstração e política de privacidade |

**Stack:** Node.js 22, TypeScript, Postgres, Twilio ConversationRelay (voz) e Claude `claude-opus-5-5` (conversa). Sem frameworks de frontend: HTML do servidor, CSS próprio e 60 linhas de JavaScript opcional.

- O guia de deploy está abaixo.
- O kit comercial está em [`docs/vendas/`](docs/vendas/).

---

## Deploy no Render (cerca de 30 minutos)

### 1. Criar as contas

| Conta | Onde | Para quê |
|---|---|---|
| GitHub | já tem | o Render faz deploy a partir do repositório |
| Render | render.com | alojamento (servidor e base de dados em Frankfurt) |
| Anthropic | console.anthropic.com | o modelo que conduz a conversa. Ative a faturação e defina um limite de gasto mensal |
| Twilio | twilio.com | números de telefone e voz. Faça o upgrade da conta trial e aceite os termos de IA (Predictive and Generative AI) para usar o ConversationRelay |

> Os números portugueses no Twilio exigem um *Regulatory Bundle* (comprovativo de morada/empresa). Trate disto cedo, porque a aprovação pode demorar alguns dias.

### 2. Gerar as chaves (no seu computador)

```bash
openssl rand -hex 32
```

Corra o comando **duas vezes**: o primeiro resultado é a `MASTER_ENCRYPTION_KEY` e o segundo fica de reserva. Guarde a `MASTER_ENCRYPTION_KEY` num gestor de passwords. **Se a perder, os dados cifrados dos clientes ficam ilegíveis.**

### 3. Criar o serviço no Render

1. Render → **New** → **Blueprint** → escolha o repositório. O Render lê o `render.yaml` e cria o serviço `atendia` e a base de dados `atendia-db` em Frankfurt.
2. Preencha as variáveis pedidas:
   - `PUBLIC_BASE_URL`: `https://atendia.onrender.com`. Confirme o URL final depois de criado e corrija se for diferente.
   - `MASTER_ENCRYPTION_KEY`: a chave do passo 2.
   - `ADMIN_EMAIL`: o seu e-mail.
   - `CONTACT_EMAIL`: o e-mail público de contacto.
   - `ANTHROPIC_API_KEY` e `TWILIO_AUTH_TOKEN`: as chaves das respetivas contas.
3. Espere pelo primeiro deploy e abra **Logs**. Vai encontrar um bloco com a **palavra-passe temporária** do administrador.
4. Abra `https://<o-seu-url>/login`, entre e defina a sua palavra-passe.

Em `/healthz` deve ver `{"status":"ok"}`.

### 4. Domínio próprio (recomendado)

No Render, em Settings → Custom Domains, adicione por exemplo `app.atendia.pt` e configure o DNS como indicado. Depois **atualize `PUBLIC_BASE_URL`** e os webhooks no Twilio para o novo domínio.

### 5. Ligar um resort

1. Em **Administração → Novo cliente**, crie o resort. Copie a palavra-passe temporária e envie-a ao cliente por um canal seguro.
2. No Twilio, compre um número e, em Voice Configuration → *A call comes in*, escolha Webhook, `POST`, com o URL mostrado na ficha do cliente (`https://<o-seu-url>/voice`). É o mesmo URL para todos os números.
3. Na ficha do cliente, indique o número no campo **Número Twilio**.
4. O cliente entra, preenche o resort (quartos, políticas, receção) e liga para o número para testar.

---

## Voz própria, sem Twilio (Asterisk + Whisper + Piper)

Alternativa mais barata ao Twilio: as chamadas chegam por um **operador SIP** a um **Asterisk** no seu servidor. O áudio é transcrito pelo **Whisper** e as respostas são faladas pelo **Piper**, ambos open-source e a correr no próprio servidor. O Claude continua a conduzir a conversa.

```
Operador SIP (número PT) ─SIP/UDP─▶ Asterisk ─AudioSocket─▶ Atendia ─▶ Claude
                                       └─ HTTP (início/transferência) ─┘    └─▶ serviço de voz (Whisper/Piper)
```

| | Twilio | Voz própria |
|---|---|---|
| Custo por minuto (estimativa) | ~$0,11–0,18 | ~0,04–0,07 € (sobretudo o Claude) |
| Número português | até $135/mês (móvel) | ~1–5 €/mês num operador SIP |
| Servidor | Render (sem UDP) | **VPS obrigatória** (UDP para SIP e áudio), 4 vCPU / 8 GB, ~15–30 €/mês |
| Tempo de resposta (medido, CPU de 4 núcleos) | ~1,5–2,5 s | ~3–4,5 s (transcrição: 0,7 s com Whisper base, 1,6 s com small) |
| Qualidade | Melhor reconhecimento e vozes | Boa; o Whisper pode errar palavras curtas ao telefone |

**Precisão da transcrição** (12 frases típicas de hóspedes, áudio telefónico de 8 kHz, CPU de 4 núcleos):

| `WHISPER_MODEL` | Erro por palavra | Tempo por frase |
|---|---|---|
| base | 57% | 1,4 s |
| **small (por omissão)** | **37%** | **1,3 s** |
| medium | 21% | 3,5 s |

Os valores são com o vocabulário do resort (nomes dos quartos e termos de reservas), que o Atendia envia automaticamente ao Whisper e que baixa o erro 8 a 10 pontos. **Atenção:** estas frases foram geradas com voz sintética, que o Whisper reconhece pior do que voz humana; mesmo sem passar pelo telefone, o erro foi de 29%. Os números servem para comparar modelos, não para prever a precisão com hóspedes reais. Teste com chamadas reais antes de vender. O assistente está instruído a pedir para repetir quando a frase não faz sentido.

**Validado:** chamadas completas num Asterisk 20 real (saudação, pergunta falada, transcrição, resposta falada, ordem de transferência para a receção), mais 8 testes automáticos (interrupção, ruído, supressão de silêncio, segredo partilhado, anti-fraude). **Por validar:** uma chamada através de um operador SIP real.

### Instalar (VPS com IP público)

1. Contrate um operador SIP com número português e acesso por registo SIP (utilizador e palavra-passe). Peça que o número marcado seja enviado no pedido SIP; se não for, use `DEFAULT_DID`.
2. No `.env`, preencha a secção "Voz própria" do `.env.example`: `ASTERISK_ENABLED=true`, `ASTERISK_SECRET`, `SPEECH_TOKEN`, `SIP_*` e `PUBLIC_IP`.
3. Arranque:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.voz.yml up -d --build
   ```
   O primeiro build descarrega cerca de 800 MB de modelos.
4. Na firewall, abra **só** `5060/udp` e `10000-10100/udp`, de preferência limitados aos IPs do operador. As portas do Atendia (8080) e do AudioSocket (9092) ficam na rede interna.
5. Na ficha do cliente (Administração), indique o número português no campo do número.

**Anti-fraude:** as transferências só são feitas para números com os prefixos de `TRANSFER_ALLOWED_PREFIXES` (por omissão, fixos e móveis portugueses), nunca para números de valor acrescentado ou internacionais. O Asterisk só aceita chamadas do operador configurado.

## Versão para PC (Windows): demonstrações

Um único `Atendia.exe` com a base de dados incluída. Abre o painel no browser e permite **testar o assistente pelo microfone**, sem Twilio. Serve para demonstrações; para clientes reais, use o deploy no servidor.

- **Download:** GitHub → Actions → último *resort-voice-agent* → artefacto **Atendia-Windows**.
- **Gerar à mão:** `node scripts/build-desktop.mjs win --with-cloudflared`, que cria `build/desktop/win/`.
- **Instruções para o utilizador:** [`docs/LEIA-ME-PC.txt`](docs/LEIA-ME-PC.txt).

## Alternativa: servidor próprio

```bash
cp .env.example .env    # preencha, incluindo POSTGRES_PASSWORD
docker compose up -d --build
```

A aplicação fica em `127.0.0.1:8080`. Ponha à frente um proxy HTTPS com suporte a WebSockets. Com o Caddy basta uma linha:

```
app.atendia.pt { reverse_proxy 127.0.0.1:8080 }
```

---

## Segurança

| Área | Medida |
|---|---|
| Chamadas | Assinatura Twilio validada em `/voice`, `/handoff` e no WebSocket. Token por chamada, de uso único e com 2 minutos de validade, ligado ao cliente. O CallSid tem de corresponder. |
| Isolamento entre clientes | O cliente é identificado pela sessão, nunca pelo pedido. Todas as consultas filtram por `tenant_id`, e há testes que tentam aceder a dados de outro resort. |
| Contas | Palavras-passe com scrypt e sal. Mínimo de 12 caracteres. Bloqueio de 15 minutos após 8 falhas. Mensagem de erro igual quer o e-mail exista ou não. Palavra-passe temporária com alteração obrigatória. Mudar a palavra-passe termina as outras sessões. |
| Sessões web | Cookie `__Host-` com `HttpOnly`, `Secure` e `SameSite=Lax`, validade de 12 h e só o hash guardado na base de dados. CSRF com token por sessão e verificação de origem. |
| Dados pessoais | Nomes e contactos dos pedidos cifrados com AES-256-GCM. Números de quem liga pseudonimizados com HMAC. Chamadas não gravadas e transcrições não guardadas. Retenção automática (90 dias, configurável). Logs sem dados pessoais. |
| Segredos dos clientes | Segredo do webhook e token do PMS cifrados. O segredo é mostrado uma só vez e o token do PMS nunca é mostrado. |
| SSRF | Os URLs de webhook e PMS só aceitam HTTPS para IPs públicos. Redes privadas, loopback e metadados da cloud são recusados no momento de guardar e no momento de chamar. |
| Web | CSP `default-src 'none'`, sem scripts inline e todo o HTML escapado. HSTS, `frame-ancestors 'none'` e rate limiting no login, no formulário do site e global. |
| Agente | Nunca aceita dados de cartão. As reservas ficam como pedidos que exigem confirmação e consentimento. Há limites por chamada. Em caso de erro ou recusa do modelo, a chamada vai para a receção. Ao atingir o limite de minutos do plano, as chamadas vão diretamente para a receção. |
| Contentor | Imagem distroless, utilizador não-root, filesystem só de leitura e `cap_drop: ALL`. |

## Desenvolvimento

É preciso um Postgres local (por omissão `postgres://postgres@127.0.0.1:54329/voice_test`, ou defina `TEST_DATABASE_URL`).

```bash
npm ci
npm run check   # tipos + 52 testes (voz, painel, admin, isolamento, CSRF, SSRF, cifra, retenção)
```

## Limitações conhecidas

- **Uma instância.** O limite de chamadas simultâneas é contado em memória. Para várias instâncias, seria preciso um contador partilhado (Redis).
- **Faturação manual.** Os minutos ficam registados por cliente e por mês, mas não há cobrança automática. Fature a partir do painel de administração ou integre o Stripe mais tarde.
- **Falta testar com chamadas reais.** Twilio e Claude são simulados nos testes automáticos. Faça chamadas de teste antes do primeiro cliente.
