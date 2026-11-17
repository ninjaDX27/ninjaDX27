import type { CallRow, Lead, Tenant } from "../db/store.js";
import type { ReservationPii } from "../reservations.js";

/** Escapa texto para HTML. TODOS os valores dinâmicos passam por aqui. */
export function h(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");

export interface Flash {
  ok?: string | undefined;
  error?: string | undefined;
}
export interface Ctx {
  brand: string;
  csrf: string;
  email: string;
  role: "owner" | "admin";
  path: string;
}

function doc(title: string, brand: string, body: string): string {
  return `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · ${h(brand)}</title>
<link rel="stylesheet" href="/assets/styles.css">
<script src="/assets/app.js" defer></script>
</head>
<body>${body}</body>
</html>`;
}

function notices(f: Flash): string {
  return (
    (f.ok ? `<div class="notice ok" role="status">${h(f.ok)}</div>` : "") +
    (f.error ? `<div class="notice error" role="alert">${h(f.error)}</div>` : "")
  );
}
const csrfField = (c: Ctx) => `<input type="hidden" name="_csrf" value="${h(c.csrf)}">`;

// ---------------------------------------------------------------- Site público

export function landingPage(brand: string, contactEmail: string | undefined, f: Flash): string {
  const features: Array<[string, string]> = [
    ["Atende à primeira, a qualquer hora", "Sem filas de espera nem chamadas perdidas fora de horas ou em época alta. Várias chamadas em simultâneo."],
    ["Fala a língua do hóspede", "Português de Portugal, inglês, espanhol, francês e alemão. Muda de idioma a meio da conversa."],
    ["Responde só com a sua informação", "Quartos, preços, políticas e serviços vêm do perfil que o resort preenche. O assistente não inventa."],
    ["Regista pedidos de reserva", "Confirma datas, ocupação e contacto, e entrega o pedido à sua equipa no painel ou no seu CRM."],
    ["Passa a chamada quando deve", "Reclamações, faturação, urgências ou um simples “quero falar com alguém” seguem para a receção."],
    ["Nunca pede dados de cartão", "O pagamento fica sempre do lado da sua equipa, por link seguro. Nada de cartões ditados ao telefone."],
  ];
  const faqs: Array<[string, string]> = [
    ["O hóspede sabe que está a falar com um assistente virtual?", "Sim. A saudação identifica o assistente como inteligência artificial e o hóspede pode pedir a receção a qualquer momento, ou marcar zero."],
    ["As chamadas são gravadas?", "Não. A conversa existe apenas durante a chamada. Guardamos a duração, o idioma e o resultado, e os dados dos pedidos de reserva ficam cifrados e são apagados ao fim do prazo de retenção."],
    ["Preciso de mudar de número?", "Não necessariamente. Pode reencaminhar o seu número atual para o número do assistente, só fora de horas ou sempre."],
    ["O assistente confirma reservas sozinho?", "Não. Regista um pedido e a sua equipa confirma. Com ligação ao seu sistema de reservas, a disponibilidade e os preços são consultados em tempo real."],
    ["E se o assistente não souber responder?", "Diz que não tem essa informação e oferece a transferência para a receção."],
  ];
  return doc(
    "Assistente telefónico para hotéis e resorts",
    brand,
    `
<header class="topbar"><div class="container">
  <a class="brand" href="/">${h(brand)}</a>
  <nav>
    <a class="plain" href="#como-funciona">Como funciona</a>
    <a class="plain" href="#seguranca">Segurança</a>
    <a class="plain" href="#perguntas">Perguntas</a>
    <a class="btn secondary small" href="/login">Entrar</a>
    <a class="btn small" href="#demo">Pedir demonstração</a>
  </nav>
</div></header>

<main>
<section class="hero"><div class="container">
  <p class="eyebrow">Assistente telefónico com IA para hotéis e resorts</p>
  <h1>A receção que atende todas as chamadas.</h1>
  <p class="lead">O ${h(brand)} atende o telefone do seu resort 24 horas por dia, responde aos hóspedes na língua deles e entrega os pedidos de reserva à sua equipa.</p>
  <div class="actions">
    <a class="btn large" href="#demo">Pedir demonstração</a>
    <a class="btn secondary large" href="#como-funciona">Ver como funciona</a>
  </div>
</div></section>

<section class="container" style="padding-bottom:88px" aria-label="Exemplo de conversa">
  <div class="transcript">
    <div class="head"><span class="live">Chamada em curso</span><span>Exemplo ilustrativo</span></div>
    <div class="msg caller">Boa tarde, têm disponibilidade para duas pessoas de 12 a 15 de agosto?</div>
    <div class="msg agent">Boa tarde. Tenho o quarto duplo com vista mar, três noites, por quatrocentos e oitenta euros. Quer que registe o pedido?</div>
    <div class="msg caller">Sim, por favor. E posso levar o cão?</div>
    <div class="msg agent">Não são permitidos animais, exceto cães de assistência. Para registar o pedido, pode dizer-me o seu nome?</div>
  </div>
</section>

<section class="section"><div class="container">
  <h2>Tudo o que uma boa receção faz ao telefone.</h2>
  <p class="sub">Menos chamadas perdidas e mais tempo para os hóspedes que estão à sua frente.</p>
  <div class="grid3">
    ${features.map(([t, d], i) => `<div class="feature"><div class="n">${String(i + 1).padStart(2, "0")}</div><h3>${h(t)}</h3><p>${h(d)}</p></div>`).join("")}
  </div>
</div></section>

<section class="section" id="como-funciona"><div class="container">
  <h2>Pronto em três passos.</h2>
  <div class="grid3">
    <div class="feature"><div class="n">Passo 1</div><h3>Preenche o perfil do resort</h3><p>Quartos, preços, políticas, serviços e perguntas frequentes, num painel simples.</p></div>
    <div class="feature"><div class="n">Passo 2</div><h3>Recebe o seu número</h3><p>Atribuímos um número ao resort. Pode publicá-lo ou reencaminhar o número atual.</p></div>
    <div class="feature"><div class="n">Passo 3</div><h3>Acompanha no painel</h3><p>Chamadas atendidas, minutos usados e pedidos de reserva por tratar, tudo num sítio.</p></div>
  </div>
</div></section>

<section class="section" id="seguranca"><div class="container split">
  <div>
    <h2>Feito para dados de hóspedes.</h2>
    <p class="sub">Segurança e privacidade por omissão, não como opção.</p>
  </div>
  <ul class="checks">
    <li>Chamadas não gravadas e transcrições não guardadas.</li>
    <li>Dados pessoais dos pedidos cifrados e apagados ao fim do prazo de retenção.</li>
    <li>O assistente identifica-se como inteligência artificial em todas as chamadas.</li>
    <li>Nunca recolhe dados de cartão, IBAN ou documentos de identificação.</li>
    <li>Cada resort só vê os seus próprios dados.</li>
  </ul>
</div></section>

<section class="section" id="perguntas"><div class="container">
  <h2>Perguntas frequentes</h2>
  <div style="margin-top:28px">
    ${faqs.map(([q, a]) => `<details><summary>${h(q)}</summary><p>${h(a)}</p></details>`).join("")}
  </div>
</div></section>

<section class="section" id="demo"><div class="container split">
  <div>
    <h2>Peça uma demonstração.</h2>
    <p class="sub">Mostramos o assistente a atender uma chamada com os dados do seu resort e enviamos uma proposta à medida do seu volume de chamadas.</p>
  </div>
  <form method="post" action="/lead" class="card">
    ${notices(f)}
    <div class="row">
      <div class="field"><label for="l-name">Nome</label><input id="l-name" type="text" name="name" required maxlength="100" autocomplete="name"></div>
      <div class="field"><label for="l-company">Hotel ou resort</label><input id="l-company" type="text" name="company" required maxlength="120" autocomplete="organization"></div>
    </div>
    <div class="row">
      <div class="field"><label for="l-email">E-mail profissional</label><input id="l-email" type="email" name="email" required maxlength="254" autocomplete="email"></div>
      <div class="field"><label for="l-phone">Telefone <span class="muted">(opcional)</span></label><input id="l-phone" type="tel" name="phone" maxlength="20" autocomplete="tel"></div>
    </div>
    <div class="field"><label for="l-msg">Mensagem <span class="muted">(opcional)</span></label><textarea id="l-msg" name="message" maxlength="1000"></textarea></div>
    <div class="sr" aria-hidden="true"><label for="l-web">Website</label><input id="l-web" type="text" name="website" tabindex="-1" autocomplete="off"></div>
    <label class="check"><input type="checkbox" name="consent" value="1" required><span>Aceito ser contactado sobre este pedido, de acordo com a <a href="/privacidade">política de privacidade</a>.</span></label>
    <div class="actions" style="margin-top:18px"><button class="btn" type="submit">Enviar pedido</button></div>
  </form>
</div></section>
</main>

<footer class="footer"><div class="container">
  <span>© ${new Date().getFullYear()} ${h(brand)}</span>
  <span><a href="/privacidade">Privacidade</a>${contactEmail ? ` · <a href="mailto:${h(contactEmail)}">${h(contactEmail)}</a>` : ""}</span>
</div></footer>`,
  );
}

export function privacyPage(brand: string, contactEmail: string | undefined, retentionDays: number): string {
  const contact = contactEmail ? `<a href="mailto:${h(contactEmail)}">${h(contactEmail)}</a>` : "o contacto indicado no contrato";
  return doc(
    "Privacidade",
    brand,
    `
<header class="topbar"><div class="container"><a class="brand" href="/">${h(brand)}</a><nav><a class="btn secondary small" href="/login">Entrar</a></nav></div></header>
<main class="container"><div class="prose">
<h1>Política de privacidade</h1>
<p>Este texto resume como o ${h(brand)} trata dados pessoais. Nas chamadas, o ${h(brand)} atua como subcontratante do hotel ou resort, que é o responsável pelo tratamento.</p>
<h2>Chamadas telefónicas</h2>
<p>As chamadas não são gravadas e as transcrições não são guardadas. Registamos a data, a duração, o idioma e o resultado de cada chamada. O número de quem liga é guardado apenas de forma pseudonimizada.</p>
<h2>Pedidos de reserva</h2>
<p>Quando o hóspede pede uma reserva e dá o seu consentimento, guardamos o nome, o contacto, as datas e as notas do pedido. Estes dados ficam cifrados, são visíveis apenas para o respetivo resort e são apagados ao fim de ${retentionDays} dias.</p>
<h2>Pedidos de demonstração</h2>
<p>Os dados enviados no formulário do site são usados apenas para responder ao pedido e são apagados ao fim de 12 meses.</p>
<h2>Subcontratantes</h2>
<p>Para prestar o serviço recorremos a fornecedores de telefonia, de reconhecimento e síntese de voz, de modelos de linguagem e de alojamento.</p>
<h2>Os seus direitos</h2>
<p>Pode pedir acesso, retificação ou apagamento dos seus dados através de ${contact}. Tem também o direito de apresentar reclamação à CNPD.</p>
</div></main>`,
  );
}

// ---------------------------------------------------------------- Autenticação

export function loginPage(brand: string, f: Flash, email = ""): string {
  return doc(
    "Entrar",
    brand,
    `<main class="auth"><div class="auth-box">
  <a class="brand" href="/" style="padding:0">${h(brand)}</a>
  <h1>Entrar</h1>
  <p class="muted">Aceda ao painel do seu resort.</p>
  ${notices(f)}
  <form method="post" action="/login">
    <div class="field"><label for="email">E-mail</label><input id="email" type="email" name="email" value="${h(email)}" required autocomplete="username" autofocus></div>
    <div class="field"><label for="password">Palavra-passe</label><input id="password" type="password" name="password" required autocomplete="current-password"></div>
    <button class="btn" type="submit">Entrar</button>
  </form>
</div></main>`,
  );
}

// ---------------------------------------------------------------- Painel

const OWNER_NAV: Array<[string, string]> = [
  ["/app", "Visão geral"],
  ["/app/reservas", "Pedidos de reserva"],
  ["/app/chamadas", "Chamadas"],
];
const OWNER_CONFIG: Array<[string, string]> = [
  ["/app/resort", "Resort"],
  ["/app/integracoes", "Integrações"],
];

function shell(c: Ctx, title: string, intro: string, body: string, f: Flash = {}, headAction = ""): string {
  const link = ([href, label]: [string, string]) => {
    const current = href === "/app" || href === "/admin" ? c.path === href : c.path.startsWith(href);
    return `<a class="nav" href="${href}"${current ? ' aria-current="page"' : ""}>${h(label)}</a>`;
  };
  const nav =
    c.role === "admin"
      ? [["/admin", "Clientes"] as [string, string], ["/admin/leads", "Pedidos de demonstração"] as [string, string]].map(link).join("")
      : OWNER_NAV.map(link).join("") + `<div class="group">Configuração</div>` + OWNER_CONFIG.map(link).join("");
  return doc(
    title,
    c.brand,
    `<div class="app">
<aside class="side">
  <a class="brand" href="${c.role === "admin" ? "/admin" : "/app"}">${h(c.brand)}</a>
  ${nav}
  <div class="foot">
    <div class="who" title="${h(c.email)}">${h(c.email)}</div>
    <a href="/conta">Conta</a> ·
    <form method="post" action="/logout" style="display:inline">${csrfField(c)}<button class="linkbtn" type="submit">Sair</button></form>
  </div>
</aside>
<main class="main">
  <div class="page-head"><div><h1>${h(title)}</h1>${intro ? `<p>${h(intro)}</p>` : ""}</div>${headAction}</div>
  ${notices(f)}
  ${body}
</main></div>`,
  );
}

const dateTime = new Intl.DateTimeFormat("pt-PT", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Lisbon" });
const duration = (s: number | null) => (s == null ? "–" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const OUTCOME: Record<string, [string, string]> = {
  transfer: ["Transferida", "warn"],
  end: ["Concluída", "ok"],
  hangup: ["Cliente desligou", ""],
};

export interface Stats {
  calls: number;
  minutes: number;
  transferred: number;
  pending: number;
  requests: number;
}

export function overviewPage(c: Ctx, t: Tenant, s: Stats, f: Flash): string {
  const pct = Math.min(100, Math.round((s.minutes / Math.max(1, t.monthly_minutes_limit)) * 100));
  const steps: Array<[boolean, string, string, string]> = [
    [t.profile.name !== "Resort Exemplo Algarve", "Preencher os dados do resort", "Quartos, preços, políticas e perguntas frequentes.", "/app/resort"],
    [!!t.reception_phone, "Indicar o telefone da receção", "Para onde o assistente transfere as chamadas.", "/app/resort"],
    [!!t.twilio_number, "Número do assistente atribuído", t.twilio_number ? `O seu número é ${t.twilio_number}.` : "A nossa equipa atribui o número e avisa-o.", "/app"],
  ];
  const allDone = steps.every((x) => x[0]);
  return shell(
    c,
    "Visão geral",
    t.name,
    `
${pct >= 90 ? `<div class="notice warn">Usou ${pct}% dos minutos deste mês. Ao atingir o limite, as chamadas passam diretamente para a receção.</div>` : ""}
<div class="stats">
  <div class="stat"><div class="k">Chamadas este mês</div><div class="v">${s.calls}</div><div class="s">${s.transferred} transferidas para a receção</div></div>
  <div class="stat"><div class="k">Pedidos de reserva</div><div class="v">${s.requests}</div><div class="s">${s.pending} por tratar</div></div>
  <div class="stat"><div class="k">Minutos usados</div><div class="v">${s.minutes}</div><div class="s">de ${t.monthly_minutes_limit} incluídos</div><div class="meter" role="img" aria-label="${pct}% dos minutos usados"><i style="width:${pct}%"></i></div></div>
  <div class="stat"><div class="k">Número do assistente</div><div class="v" style="font-size:20px;padding-top:8px">${t.twilio_number ? h(t.twilio_number) : "Por atribuir"}</div><div class="s">${t.status === "active" ? "Ativo" : "Suspenso"}</div></div>
</div>
${
  allDone
    ? `<div class="card"><h2>${s.pending > 0 ? `Tem ${s.pending} pedido${s.pending === 1 ? "" : "s"} de reserva por tratar` : "Está tudo em dia"}</h2><p class="muted">${s.pending > 0 ? "Confirme ou recuse cada pedido depois de falar com o hóspede." : "Os novos pedidos de reserva aparecem aqui e na página de pedidos."}</p>${s.pending > 0 ? `<a class="btn" href="/app/reservas">Ver pedidos</a>` : ""}</div>`
    : `<div class="card"><h2>Primeiros passos</h2><p class="muted">Conclua estes passos para o assistente começar a atender.</p><ul class="steps">${steps
        .map(
          ([done, title, desc, href]) =>
            `<li><span class="dot${done ? " done" : ""}">${done ? "✓" : ""}</span><div><strong>${h(title)}</strong><div class="muted small">${h(desc)}</div></div>${done ? "" : `<a class="btn secondary small" style="margin-left:auto" href="${href}">Abrir</a>`}</li>`,
        )
        .join("")}</ul></div>`
}`,
    f,
  );
}

export function callsPage(c: Ctx, calls: CallRow[]): string {
  const body =
    calls.length === 0
      ? `<div class="empty"><strong>Ainda não há chamadas</strong>As chamadas atendidas pelo assistente aparecem aqui.</div>`
      : `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Resultado</th><th>Idioma</th><th class="num">Duração</th><th class="num">Trocas</th></tr></thead><tbody>${calls
          .map((x) => {
            const [label, cls] = OUTCOME[x.outcome ?? ""] ?? ["Em curso", ""];
            return `<tr><td>${h(dateTime.format(x.started_at))}</td><td><span class="badge ${cls}">${label}</span></td><td>${h(x.language ?? "–")}</td><td class="num">${duration(x.duration_s)}</td><td class="num">${x.turns ?? "–"}</td></tr>`;
          })
          .join("")}</tbody></table></div><p class="hint">As chamadas não são gravadas. O número de quem liga não é guardado.</p>`;
  return shell(c, "Chamadas", "As últimas 100 chamadas atendidas pelo assistente.", body);
}

export interface ReservationView {
  id: string;
  created_at: Date;
  check_in: string;
  check_out: string;
  room: string;
  adults: number;
  children: number;
  quoted_total: string | null;
  currency: string;
  status: "pending" | "confirmed" | "declined";
  delivered: boolean;
  pii: ReservationPii | null;
}
const STATUS: Record<string, [string, string]> = {
  pending: ["Por tratar", "warn"],
  confirmed: ["Confirmado", "ok"],
  declined: ["Recusado", "danger"],
};

export function reservationsPage(c: Ctx, rows: ReservationView[], f: Flash): string {
  const fmtDate = (d: string) => d.split("-").reverse().join("/");
  const body =
    rows.length === 0
      ? `<div class="empty"><strong>Ainda não há pedidos de reserva</strong>Quando um hóspede pedir uma reserva ao telefone, o pedido aparece aqui.</div>`
      : `<div class="table-wrap"><table><thead><tr><th>Recebido</th><th>Hóspede</th><th>Estadia</th><th>Quarto</th><th class="num">Valor indicativo</th><th>Estado</th><th><span class="sr">Ações</span></th></tr></thead><tbody>${rows
          .map((r) => {
            const [label, cls] = STATUS[r.status]!;
            const contact = r.pii
              ? [r.pii.contact_phone ?? r.pii.caller_phone, r.pii.email].filter(Boolean).map(h).join("<br>")
              : "";
            const guest = r.pii
              ? `<strong>${h(r.pii.guest_name)}</strong><div class="muted small">${contact}</div>${r.pii.notes ? `<div class="small" style="margin-top:4px">${h(r.pii.notes)}</div>` : ""}`
              : `<span class="muted">Dados apagados (prazo de retenção)</span>`;
            const btn = (status: string, text: string, cls2: string) =>
              `<form method="post" action="/app/reservas/${h(r.id)}/estado" style="display:inline">${csrfField(c)}<input type="hidden" name="status" value="${status}"><button class="btn small ${cls2}" type="submit">${text}</button></form>`;
            const actions =
              r.status === "pending" ? btn("confirmed", "Confirmar", "") + " " + btn("declined", "Recusar", "secondary") : btn("pending", "Reabrir", "secondary");
            return `<tr><td>${h(dateTime.format(r.created_at))}</td><td>${guest}</td><td>${fmtDate(r.check_in)} a ${fmtDate(r.check_out)}<div class="muted small">${r.adults} adulto${r.adults === 1 ? "" : "s"}${r.children ? `, ${r.children} criança${r.children === 1 ? "" : "s"}` : ""}</div></td><td>${h(r.room)}</td><td class="num">${r.quoted_total ? `${h(Number(r.quoted_total).toFixed(2))} ${h(r.currency)}` : "–"}</td><td><span class="badge ${cls}">${label}</span></td><td style="white-space:nowrap">${actions}</td></tr>`;
          })
          .join("")}</tbody></table></div><p class="hint">São pedidos, não reservas confirmadas. Contacte o hóspede e envie o link de pagamento antes de confirmar.</p>`;
  return shell(c, "Pedidos de reserva", "Pedidos registados pelo assistente ao telefone.", body, f);
}

// ---- Configuração do resort (4 separadores)

export interface DraftRoom {
  id: string; name: string; description: string;
  max_adults: number; max_children: number; max_occupancy: number; nightly_rate_from: number; units: number;
}
export interface DraftProfile {
  name: string; address: string; website?: string | undefined; email?: string | undefined;
  rooms: DraftRoom[];
  booking_rules: { min_nights: number; max_nights: number; max_days_in_advance: number };
  policies: Record<string, string>;
  facilities: string[];
  faq: Array<{ q: string; a: string }>;
  languages: Array<{ code: string; welcomeGreeting: string }>;
}

const TABS: Array<[string, string]> = [
  ["/app/resort", "Geral"],
  ["/app/resort/quartos", "Quartos"],
  ["/app/resort/informacao", "Informação"],
  ["/app/resort/idiomas", "Idiomas"],
];
function resortShell(c: Ctx, body: string, f: Flash): string {
  const tabs = `<nav class="tabs" aria-label="Secções">${TABS.map(([href, label]) => `<a href="${href}"${c.path === href ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  return shell(c, "Resort", "O assistente responde apenas com a informação que preencher aqui.", tabs + body, f);
}
const saveBar = `<div class="actions"><button class="btn" type="submit">Guardar alterações</button></div>`;

export function resortGeneralPage(c: Ctx, p: DraftProfile, reception: string, f: Flash): string {
  return resortShell(
    c,
    `<form method="post" action="/app/resort">${csrfField(c)}
<div class="card"><h2>Identificação</h2><p class="muted">Como o assistente apresenta o resort.</p>
  <div class="field"><label for="name">Nome do resort</label><input id="name" type="text" name="name" value="${h(p.name)}" required maxlength="100"></div>
  <div class="field"><label for="address">Morada</label><input id="address" type="text" name="address" value="${h(p.address)}" required maxlength="200"></div>
  <div class="row">
    <div class="field"><label for="website">Website <span class="muted">(opcional)</span></label><input id="website" type="url" name="website" value="${h(p.website)}" placeholder="https://" maxlength="200"></div>
    <div class="field"><label for="email">E-mail de reservas <span class="muted">(opcional)</span></label><input id="email" type="email" name="email" value="${h(p.email)}" maxlength="254"></div>
  </div>
</div>
<div class="card"><h2>Receção</h2><p class="muted">Para onde o assistente transfere quando o hóspede pede para falar com alguém.</p>
  <div class="field" style="max-width:320px"><label for="reception">Telefone da receção</label><input id="reception" type="tel" name="reception_phone" value="${h(reception)}" placeholder="+351210000000" required maxlength="16"><div class="hint">Formato internacional, com indicativo do país.</div></div>
</div>
<div class="card"><h2>Regras de reserva</h2><p class="muted">O assistente recusa pedidos fora destes limites.</p>
  <div class="row">
    <div class="field"><label for="min">Estadia mínima (noites)</label><input id="min" type="number" name="min_nights" min="1" max="30" value="${num(p.booking_rules.min_nights)}" required></div>
    <div class="field"><label for="max">Estadia máxima (noites)</label><input id="max" type="number" name="max_nights" min="1" max="90" value="${num(p.booking_rules.max_nights)}" required></div>
    <div class="field"><label for="adv">Antecedência máxima (dias)</label><input id="adv" type="number" name="max_days_in_advance" min="1" max="730" value="${num(p.booking_rules.max_days_in_advance)}" required></div>
  </div>
</div>${saveBar}</form>`,
    f,
  );
}

function roomBlock(r: Partial<DraftRoom>): string {
  return `<div class="repeat">
  <div class="repeat-head"><strong>${r.name ? h(r.name) : "Novo quarto"}</strong><button class="btn small danger" type="button" data-remove>Remover</button></div>
  <input type="hidden" name="room_id" value="${h(r.id)}">
  <div class="row">
    <div class="field"><label>Nome</label><input type="text" name="room_name" value="${h(r.name)}" maxlength="80" placeholder="Quarto Duplo Vista Mar"></div>
    <div class="field"><label>Preço desde (por noite)</label><input type="number" name="room_rate" value="${num(r.nightly_rate_from)}" min="1" step="0.01"></div>
    <div class="field"><label>Unidades</label><input type="number" name="room_units" value="${num(r.units ?? 1)}" min="0" max="999"></div>
  </div>
  <div class="field"><label>Descrição</label><input type="text" name="room_description" value="${h(r.description)}" maxlength="300" placeholder="Cama de casal, varanda com vista mar, 30 metros quadrados."></div>
  <div class="row">
    <div class="field"><label>Máx. adultos</label><input type="number" name="room_adults" value="${num(r.max_adults ?? 2)}" min="1" max="20"></div>
    <div class="field"><label>Máx. crianças</label><input type="number" name="room_children" value="${num(r.max_children ?? 0)}" min="0" max="20"></div>
    <div class="field"><label>Máx. pessoas no total</label><input type="number" name="room_occupancy" value="${num(r.max_occupancy ?? 2)}" min="1" max="30"></div>
  </div>
</div>`;
}

export function resortRoomsPage(c: Ctx, p: DraftProfile, f: Flash): string {
  return resortShell(
    c,
    `<form method="post" action="/app/resort/quartos">${csrfField(c)}
<div id="rooms">${p.rooms.map(roomBlock).join("")}</div>
<template id="room-tpl">${roomBlock({})}</template>
<noscript>${roomBlock({})}<p class="hint">Para remover um quarto, apague o nome e guarde.</p></noscript>
<div class="actions"><button class="btn secondary" type="button" data-add="room-tpl" data-into="rooms">Adicionar quarto</button><button class="btn" type="submit">Guardar alterações</button></div>
<p class="hint">Os preços são indicativos (“desde”). O assistente diz sempre que a equipa confirma o valor final.</p>
</form>`,
    f,
  );
}

function pairBlock(kind: "policy" | "faq", a = "", b = ""): string {
  const [la, lb, pa, pb] =
    kind === "policy" ? ["Tema", "O que o assistente deve dizer", "Check-in", "a partir das 15h00"] : ["Pergunta", "Resposta", "Têm transfer do aeroporto?", "Sim, a pedido, a partir de 45 euros por trajeto."];
  return `<div class="repeat"><div class="row" style="grid-template-columns:minmax(140px,1fr) 2fr auto;align-items:end">
  <div class="field" style="margin:0"><label>${la}</label><input type="text" name="${kind}_a" value="${h(a)}" maxlength="${kind === "policy" ? 60 : 200}" placeholder="${pa}"></div>
  <div class="field" style="margin:0"><label>${lb}</label><input type="text" name="${kind}_b" value="${h(b)}" maxlength="500" placeholder="${pb}"></div>
  <button class="btn small danger" type="button" data-remove>Remover</button>
</div></div>`;
}

export function resortInfoPage(c: Ctx, p: DraftProfile, f: Flash): string {
  return resortShell(
    c,
    `<form method="post" action="/app/resort/informacao">${csrfField(c)}
<div class="card"><h2>Políticas</h2><p class="muted">Check-in, cancelamento, animais, estacionamento e outras regras.</p>
  <div id="policies">${Object.entries(p.policies).map(([k, v]) => pairBlock("policy", k, v)).join("")}</div>
  <template id="policy-tpl">${pairBlock("policy")}</template><noscript>${pairBlock("policy")}</noscript>
  <button class="btn secondary small" type="button" data-add="policy-tpl" data-into="policies">Adicionar política</button>
</div>
<div class="card"><h2>Instalações e serviços</h2><p class="muted">Um por linha. Inclua horários quando fizer sentido.</p>
  <textarea name="facilities" rows="7" maxlength="4000" aria-label="Instalações e serviços">${h(p.facilities.join("\n"))}</textarea>
</div>
<div class="card"><h2>Perguntas frequentes</h2><p class="muted">As perguntas que a receção mais ouve ao telefone.</p>
  <div id="faqs">${p.faq.map((x) => pairBlock("faq", x.q, x.a)).join("")}</div>
  <template id="faq-tpl">${pairBlock("faq")}</template><noscript>${pairBlock("faq")}</noscript>
  <button class="btn secondary small" type="button" data-add="faq-tpl" data-into="faqs">Adicionar pergunta</button>
</div>${saveBar}</form>`,
    f,
  );
}

export interface LanguageOption {
  code: string;
  label: string;
  defaultGreeting: string;
}
export function resortLanguagesPage(c: Ctx, p: DraftProfile, options: LanguageOption[], f: Flash): string {
  const primary = p.languages[0]?.code;
  return resortShell(
    c,
    `<form method="post" action="/app/resort/idiomas">${csrfField(c)}
<div class="card"><h2>Idioma principal</h2><p class="muted">O idioma em que o assistente atende.</p>
  <div class="field" style="max-width:280px"><label for="primary" class="sr">Idioma principal</label><select id="primary" name="primary">${options.map((o) => `<option value="${o.code}"${o.code === primary ? " selected" : ""}>${h(o.label)}</option>`).join("")}</select></div>
</div>
${options
  .map((o) => {
    const cur = p.languages.find((l) => l.code === o.code);
    return `<div class="card"><label class="check" style="font-weight:600;font-size:16px"><input type="checkbox" name="lang" value="${o.code}"${cur ? " checked" : ""}><span>${h(o.label)}</span></label>
  <div class="field" style="margin:14px 0 0"><label for="g-${o.code}">Saudação</label><textarea id="g-${o.code}" name="greeting_${o.code}" rows="3" maxlength="400">${h(cur?.welcomeGreeting ?? o.defaultGreeting)}</textarea></div></div>`;
  })
  .join("")}
<p class="hint">Mantenha na saudação a indicação de que é um assistente virtual de inteligência artificial. É uma obrigação de transparência.</p>
${saveBar}</form>`,
    f,
  );
}

export function integrationsPage(c: Ctx, t: Tenant, f: Flash, newSecret?: string): string {
  return shell(
    c,
    "Integrações",
    "Ligue o assistente aos sistemas do resort. Tudo isto é opcional.",
    `
${newSecret ? `<div class="card"><h2>Novo segredo do webhook</h2><p class="muted">Guarde-o agora. Não volta a ser mostrado.</p><div class="secret" id="new-secret">${h(newSecret)}</div><div class="actions"><button class="btn secondary small" type="button" data-copy="new-secret">Copiar</button></div></div>` : ""}
<form method="post" action="/app/integracoes">${csrfField(c)}
<div class="card"><h2>Webhook de pedidos de reserva</h2><p class="muted">Receba cada pedido no seu CRM, n8n ou sistema de reservas. Os pedidos ficam sempre também no painel.</p>
  <div class="field"><label for="wh">URL do webhook</label><input id="wh" type="url" name="webhook_url" value="${h(t.webhook_url)}" placeholder="https://" maxlength="300"><div class="hint">Cada entrega é assinada (HMAC-SHA256) com o segredo. ${t.webhook_secret_enc ? "Já existe um segredo configurado." : "O segredo é gerado ao guardar."}</div></div>
  ${t.webhook_secret_enc ? `<label class="check"><input type="checkbox" name="rotate_secret" value="1"><span>Gerar um novo segredo (o anterior deixa de funcionar)</span></label>` : ""}
</div>
<div class="card"><h2>Disponibilidade em tempo real</h2><p class="muted">Sem esta ligação, o assistente usa os preços indicativos dos quartos. Com ela, consulta o seu sistema de reservas.</p>
  <div class="field"><label for="pms">URL da API</label><input id="pms" type="url" name="pms_url" value="${h(t.pms_url)}" placeholder="https://" maxlength="300"></div>
  <div class="field"><label for="pmst">Token de acesso</label><input id="pmst" type="password" name="pms_token" autocomplete="off" maxlength="300" placeholder="${t.pms_token_enc ? "•••••••• (guardado)" : ""}"><div class="hint">${t.pms_token_enc ? "Deixe em branco para manter o token atual." : "Guardado cifrado."}</div></div>
</div>${saveBar}</form>`,
    f,
  );
}

export function accountPage(c: Ctx, mustChange: boolean, f: Flash): string {
  return shell(
    c,
    "Conta",
    c.email,
    `${mustChange ? `<div class="notice warn">Defina uma palavra-passe nova para continuar.</div>` : ""}
<form method="post" action="/conta" class="card" style="max-width:460px">${csrfField(c)}
  <h2>Alterar palavra-passe</h2><p class="muted">Pelo menos 12 caracteres, com letras e números.</p>
  <div class="field"><label for="cur">Palavra-passe atual</label><input id="cur" type="password" name="current" required autocomplete="current-password"></div>
  <div class="field"><label for="new">Nova palavra-passe</label><input id="new" type="password" name="password" required minlength="12" autocomplete="new-password"></div>
  <div class="field"><label for="rep">Repetir nova palavra-passe</label><input id="rep" type="password" name="confirm" required minlength="12" autocomplete="new-password"></div>
  <button class="btn" type="submit">Guardar palavra-passe</button>
</form>`,
    f,
  );
}

// ---------------------------------------------------------------- Administração

export function adminTenantsPage(c: Ctx, tenants: Array<Tenant & { minutes_used: number; owner_email: string | null }>, f: Flash): string {
  const body =
    tenants.length === 0
      ? `<div class="empty"><strong>Ainda não há clientes</strong>Crie o primeiro resort para começar.</div>`
      : `<div class="table-wrap"><table><thead><tr><th>Resort</th><th>Número</th><th>Conta</th><th class="num">Minutos (mês)</th><th>Estado</th></tr></thead><tbody>${tenants
          .map(
            (t) =>
              `<tr><td><a href="/admin/clientes/${h(t.id)}"><strong>${h(t.name)}</strong></a></td><td>${t.twilio_number ? h(t.twilio_number) : `<span class="badge warn">Por atribuir</span>`}</td><td>${h(t.owner_email ?? "–")}</td><td class="num">${t.minutes_used} / ${t.monthly_minutes_limit}</td><td><span class="badge ${t.status === "active" ? "ok" : "danger"}">${t.status === "active" ? "Ativo" : "Suspenso"}</span></td></tr>`,
          )
          .join("")}</tbody></table></div>`;
  return shell(c, "Clientes", "Resorts que usam o serviço.", body, f, `<a class="btn" href="/admin/clientes/novo">Novo cliente</a>`);
}

export function adminNewTenantPage(c: Ctx, f: Flash, v = { name: "", email: "" }): string {
  return shell(
    c,
    "Novo cliente",
    "Cria o resort e a conta de acesso do cliente.",
    `<form method="post" action="/admin/clientes/novo" class="card" style="max-width:520px">${csrfField(c)}
  <div class="field"><label for="name">Nome do resort</label><input id="name" type="text" name="name" value="${h(v.name)}" required maxlength="100" autofocus></div>
  <div class="field"><label for="email">E-mail do cliente</label><input id="email" type="email" name="email" value="${h(v.email)}" required maxlength="254"><div class="hint">É gerada uma palavra-passe temporária, mostrada uma única vez.</div></div>
  <div class="actions"><button class="btn" type="submit">Criar cliente</button><a class="btn secondary" href="/admin">Cancelar</a></div>
</form>`,
    f,
  );
}

export function adminTenantPage(c: Ctx, t: Tenant, ownerEmail: string | null, voiceUrl: string, f: Flash, tempPassword?: string): string {
  return shell(
    c,
    t.name,
    ownerEmail ?? "",
    `
${tempPassword ? `<div class="card"><h2>Palavra-passe temporária</h2><p class="muted">Envie-a ao cliente por um canal seguro. Não volta a ser mostrada e tem de ser alterada no primeiro acesso.</p><div class="secret" id="tmp-pw">${h(tempPassword)}</div><div class="actions"><button class="btn secondary small" type="button" data-copy="tmp-pw">Copiar</button></div></div>` : ""}
<form method="post" action="/admin/clientes/${h(t.id)}" class="card">${csrfField(c)}
  <h2>Serviço</h2><p class="muted">Número, limites do plano e estado.</p>
  <div class="row">
    <div class="field"><label for="num">Número Twilio</label><input id="num" type="tel" name="twilio_number" value="${h(t.twilio_number)}" placeholder="+351300000000" maxlength="16"><div class="hint">Formato internacional. Deixe vazio para desligar.</div></div>
    <div class="field"><label for="st">Estado</label><select id="st" name="status"><option value="active"${t.status === "active" ? " selected" : ""}>Ativo</option><option value="suspended"${t.status === "suspended" ? " selected" : ""}>Suspenso</option></select></div>
  </div>
  <div class="row">
    <div class="field"><label for="min">Minutos incluídos por mês</label><input id="min" type="number" name="monthly_minutes_limit" value="${t.monthly_minutes_limit}" min="0" max="1000000" required></div>
    <div class="field"><label for="cc">Chamadas em simultâneo</label><input id="cc" type="number" name="max_concurrent_calls" value="${t.max_concurrent_calls}" min="1" max="100" required></div>
  </div>
  <div class="actions"><button class="btn" type="submit">Guardar</button></div>
</form>
<div class="card"><h2>Configuração no Twilio</h2><p class="muted">No número, em Voice Configuration, defina “A call comes in” como Webhook (HTTP POST) para:</p><div class="secret" id="voice-url">${h(voiceUrl)}</div><div class="actions"><button class="btn secondary small" type="button" data-copy="voice-url">Copiar</button></div></div>
<div class="card"><h2>Acesso do cliente</h2><p class="muted">Gera uma palavra-passe temporária nova e termina as sessões abertas.</p>
  <form method="post" action="/admin/clientes/${h(t.id)}/palavra-passe">${csrfField(c)}<button class="btn secondary" type="submit">Repor palavra-passe</button></form>
</div>`,
    f,
  );
}

export function adminLeadsPage(c: Ctx, leads: Lead[]): string {
  const body =
    leads.length === 0
      ? `<div class="empty"><strong>Ainda não há pedidos</strong>Os pedidos de demonstração enviados no site aparecem aqui.</div>`
      : `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Nome</th><th>Resort</th><th>Contacto</th><th>Mensagem</th></tr></thead><tbody>${leads
          .map(
            (l) =>
              `<tr><td>${h(dateTime.format(l.created_at))}</td><td>${h(l.name)}</td><td>${h(l.company)}</td><td><a href="mailto:${h(l.email)}">${h(l.email)}</a>${l.phone ? `<br>${h(l.phone)}` : ""}</td><td>${h(l.message ?? "")}</td></tr>`,
          )
          .join("")}</tbody></table></div>`;
  return shell(c, "Pedidos de demonstração", "Contactos recebidos pelo formulário do site.", body);
}
