import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  passwordPolicyError,
  randomToken,
  safeEqual,
  sha256,
  temporaryPassword,
  verifyPassword,
} from "../crypto.js";
import type { Tenant, User } from "../db/store.js";
import { publicHttpsUrlError } from "../net.js";
import type { ReservationPii } from "../reservations.js";
import { ResortSchema, type Resort } from "../resort.js";
import type { AppDeps } from "../server.js";
import * as V from "./views.js";

const COOKIE = "__Host-sid";
const SESSION_HOURS = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

export const LANGUAGE_OPTIONS: V.LanguageOption[] = [
  { code: "pt-PT", label: "Português", defaultGreeting: "Olá, obrigado por ligar. Fala com o assistente virtual, um sistema de inteligência artificial. Esta chamada não é gravada. Pode pedir a qualquer momento para falar com a receção, ou marcar zero. Em que posso ajudar?" },
  { code: "en-GB", label: "English", defaultGreeting: "Hello, thank you for calling. You are speaking with a virtual assistant powered by artificial intelligence. This call is not recorded. You can ask for reception at any time or press zero. How can I help?" },
  { code: "es-ES", label: "Español", defaultGreeting: "Hola, gracias por llamar. Habla con un asistente virtual de inteligencia artificial. Esta llamada no se graba. Puede pedir hablar con recepción o pulsar cero. ¿En qué puedo ayudarle?" },
  { code: "fr-FR", label: "Français", defaultGreeting: "Bonjour, merci de votre appel. Vous parlez avec un assistant virtuel doté d'intelligence artificielle. Cet appel n'est pas enregistré. Vous pouvez demander la réception ou appuyer sur zéro. Comment puis-je vous aider ?" },
  { code: "de-DE", label: "Deutsch", defaultGreeting: "Guten Tag, vielen Dank für Ihren Anruf. Sie sprechen mit einem virtuellen Assistenten mit künstlicher Intelligenz. Dieser Anruf wird nicht aufgezeichnet. Sie können jederzeit die Rezeption verlangen oder die Null drücken. Wie kann ich Ihnen helfen?" },
];

interface Auth {
  user: User;
  csrf: string;
  tokenHash: string;
}
type AuthedRequest = Request & { auth?: Auth };

const text = (v: unknown, max = 500): string =>
  (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => text(x, 600)) : v === undefined ? [] : [text(v, 600)]);
const int = (v: unknown): number => {
  const s = text(v, 12);
  return /^-?\d+$/.test(s) ? Number(s) : NaN;
};
const dec = (v: unknown): number => {
  const s = text(v, 12).replace(",", ".");
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN;
};
const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "quarto";

/** Mensagens de validação legíveis para quem preenche o formulário. */
function profileError(err: z.ZodError): string {
  const labels: Record<string, string> = {
    name: "Nome", address: "Morada", website: "Website", email: "E-mail", description: "Descrição",
    max_adults: "Máx. adultos", max_children: "Máx. crianças", max_occupancy: "Máx. pessoas",
    nightly_rate_from: "Preço por noite", units: "Unidades", welcomeGreeting: "Saudação",
    min_nights: "Estadia mínima", max_nights: "Estadia máxima", max_days_in_advance: "Antecedência máxima",
  };
  const i = err.issues[0]!;
  const p = i.path;
  const field = labels[String(p[p.length - 1])] ?? "";
  let where = "";
  if (p[0] === "rooms" && typeof p[1] === "number") where = `Quarto ${p[1] + 1}`;
  else if (p[0] === "rooms") return "Adicione pelo menos um quarto.";
  else if (p[0] === "languages" && typeof p[1] === "number") where = "Idiomas";
  else if (p[0] === "languages") return "Escolha pelo menos um idioma.";
  else if (p[0] === "policies") return "Preencha o tema e o texto de cada política.";
  else if (p[0] === "faq") return "Preencha a pergunta e a resposta.";
  const what = [where, field].filter(Boolean).join(" · ");
  return what ? `${what}: verifique o valor introduzido.` : "Verifique os valores introduzidos.";
}

export function mountWeb(app: Express, deps: AppDeps): void {
  const { config, store, log } = deps;
  const brand = config.BRAND_NAME;
  const publicDir = deps.publicDir ?? fileURLToPath(new URL("../../public", import.meta.url));

  app.use("/assets", express.static(publicDir, { maxAge: "1h", index: false, redirect: false }));

  const form = express.urlencoded({ extended: false, limit: "100kb", parameterLimit: 1000 });
  const html = (res: Response, body: string, status = 200) =>
    res.status(status).type("html").set("cache-control", "no-store").send(body);

  /** Defesa CSRF nº 1: pedidos de escrita têm de vir da nossa própria origem. */
  const sameOrigin = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin") ?? "";
    const referer = req.header("referer") ?? "";
    const ok = origin ? origin === config.PUBLIC_BASE_URL : referer.startsWith(`${config.PUBLIC_BASE_URL}/`);
    if (!ok) return res.status(403).type("text/plain").send("Forbidden");
    next();
  };

  const readCookie = (req: Request): string | null => {
    for (const part of (req.header("cookie") ?? "").split(";")) {
      const [k, v] = part.trim().split("=");
      if (k === COOKIE && v && /^[A-Za-z0-9_-]{20,100}$/.test(v)) return v;
    }
    return null;
  };
  const setCookie = (res: Response, token: string, maxAge: number) =>
    res.append("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);

  const loadAuth = async (req: AuthedRequest): Promise<Auth | null> => {
    const token = readCookie(req);
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = await store.sessionByHash(tokenHash);
    if (!session) return null;
    const user = await store.userById(session.user_id);
    return user ? { user, csrf: session.csrf, tokenHash } : null;
  };

  /** Exige sessão, o papel certo e (em POST) o token CSRF da sessão. */
  const guard = (role: "owner" | "admin" | "any") => async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const auth = await loadAuth(req);
    if (!auth) return res.redirect(303, "/login");
    if (role !== "any" && auth.user.role !== role) return res.redirect(303, auth.user.role === "admin" ? "/admin" : "/app");
    if (req.method === "POST" && !safeEqual(text(req.body?._csrf, 200), auth.csrf)) {
      return res.status(403).type("text/plain").send("Forbidden");
    }
    if (auth.user.must_change_password && req.path !== "/conta" && req.path !== "/logout") return res.redirect(303, "/conta");
    req.auth = auth;
    next();
  };
  const post = [form, sameOrigin] as const;

  const ctx = (req: AuthedRequest): V.Ctx => ({
    brand,
    csrf: req.auth!.csrf,
    email: req.auth!.user.email,
    role: req.auth!.user.role,
    path: req.path,
  });
  const tenantOf = async (req: AuthedRequest): Promise<Tenant> => {
    const t = await store.tenantById(req.auth!.user.tenant_id!);
    if (!t) throw Object.assign(new Error("cliente inexistente"), { status: 404 });
    return t;
  };
  const flash = (req: Request): V.Flash => {
    const ok: Record<string, string> = {
      guardado: "Alterações guardadas.",
      criado: "Cliente criado.",
      estado: "Pedido atualizado.",
      password: "Palavra-passe alterada.",
      lead: "Pedido enviado. Entramos em contacto em breve.",
    };
    return { ok: ok[text(req.query.ok, 20)] };
  };

  // ------------------------------------------------------------ Público
  app.get("/", (req, res) => html(res, V.landingPage(brand, config.CONTACT_EMAIL, flash(req))));
  app.get("/privacidade", (_req, res) => html(res, V.privacyPage(brand, config.CONTACT_EMAIL, config.RETENTION_DAYS)));

  const leadLimit = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false });
  const LeadSchema = z.object({
    name: z.string().min(2).max(100),
    company: z.string().min(2).max(120),
    email: z.string().email().max(254),
    phone: z.string().regex(/^\+?[0-9 ]{7,20}$/).nullable(),
    message: z.string().max(1000).nullable(),
  });
  app.post("/lead", leadLimit, ...post, async (req, res) => {
    // Campo-armadilha: os bots preenchem-no, as pessoas não o veem.
    if (text(req.body?.website)) return res.redirect(303, "/?ok=lead#demo");
    const parsed = LeadSchema.safeParse({
      name: text(req.body?.name, 100),
      company: text(req.body?.company, 120),
      email: text(req.body?.email, 254).toLowerCase(),
      phone: text(req.body?.phone, 20) || null,
      message: text(req.body?.message, 1000) || null,
    });
    if (!parsed.success || text(req.body?.consent) !== "1") {
      return html(res, V.landingPage(brand, config.CONTACT_EMAIL, { error: "Verifique os dados do formulário e aceite a política de privacidade." }), 400);
    }
    await store.insertLead(parsed.data);
    res.redirect(303, "/?ok=lead#demo");
  });

  // ------------------------------------------------------------ Autenticação
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, skipSuccessfulRequests: true });
  const BAD_LOGIN = "E-mail ou palavra-passe incorretos.";

  app.get("/login", async (req: AuthedRequest, res) => {
    const auth = await loadAuth(req);
    if (auth) return res.redirect(303, auth.user.role === "admin" ? "/admin" : "/app");
    html(res, V.loginPage(brand, {}));
  });

  app.post("/login", loginLimit, ...post, async (req, res) => {
    const email = text(req.body?.email, 254).toLowerCase();
    const password = text(req.body?.password, 200);
    const user = await store.userByEmail(email);
    // Verifica sempre um hash, mesmo sem utilizador, para não revelar quais os e-mails que existem.
    const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    const locked = !!user?.locked_until && user.locked_until > new Date();
    if (!user || !valid || locked) {
      if (user && !locked) await store.recordLoginFailure(user.id);
      if (user) await store.audit(user.id, user.tenant_id, "login_falhado");
      return html(res, V.loginPage(brand, { error: locked ? "Conta bloqueada temporariamente por tentativas falhadas. Tente daqui a 15 minutos." : BAD_LOGIN }, email), 401);
    }
    await store.recordLoginSuccess(user.id);
    const token = randomToken();
    await store.createSession(sha256(token), user.id, randomToken(24), SESSION_HOURS);
    await store.audit(user.id, user.tenant_id, "login");
    setCookie(res, token, SESSION_HOURS * 3600);
    res.redirect(303, user.role === "admin" ? "/admin" : "/app");
  });

  app.post("/logout", ...post, guard("any"), async (req: AuthedRequest, res) => {
    await store.deleteSession(req.auth!.tokenHash);
    setCookie(res, "x", 0);
    res.redirect(303, "/login");
  });

  app.get("/conta", guard("any"), (req: AuthedRequest, res) => html(res, V.accountPage(ctx(req), req.auth!.user.must_change_password, flash(req))));
  app.post("/conta", ...post, guard("any"), async (req: AuthedRequest, res) => {
    const user = req.auth!.user;
    const current = text(req.body?.current, 200);
    const password = text(req.body?.password, 200);
    const fail = (error: string) => html(res, V.accountPage(ctx(req), user.must_change_password, { error }), 400);
    if (!(await verifyPassword(current, user.password_hash))) return fail("A palavra-passe atual não está correta.");
    if (password !== text(req.body?.confirm, 200)) return fail("As duas palavras-passe novas não coincidem.");
    if (password === current) return fail("A nova palavra-passe tem de ser diferente da atual.");
    const policy = passwordPolicyError(password);
    if (policy) return fail(policy);
    await store.setPassword(user.id, await hashPassword(password), false); // termina todas as sessões
    const token = randomToken();
    await store.createSession(sha256(token), user.id, randomToken(24), SESSION_HOURS);
    await store.audit(user.id, user.tenant_id, "password_alterada");
    setCookie(res, token, SESSION_HOURS * 3600);
    res.redirect(303, "/conta?ok=password");
  });

  // ------------------------------------------------------------ Painel do cliente
  const owner = guard("owner");

  app.get("/app", owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    html(res, V.overviewPage(ctx(req), t, await store.monthStats(t.id), flash(req)));
  });

  app.get("/app/chamadas", owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    html(res, V.callsPage(ctx(req), await store.listCalls(t.id)));
  });

  app.get("/app/reservas", owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    const rooms = new Map(t.profile.rooms.map((r) => [r.id, r.name]));
    const rows = (await store.listReservations(t.id)).map((r): V.ReservationView => {
      let pii: ReservationPii | null = null;
      if (r.pii_enc) {
        try {
          pii = JSON.parse(deps.crypto.decrypt(r.pii_enc)) as ReservationPii;
        } catch {
          log.error({ reservation: r.id }, "não foi possível decifrar um pedido");
        }
      }
      return { ...r, room: rooms.get(r.room_type) ?? r.room_type, pii };
    });
    html(res, V.reservationsPage(ctx(req), rows, flash(req)));
  });

  app.post("/app/reservas/:id/estado", ...post, owner, async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const status = z.enum(["pending", "confirmed", "declined"]).safeParse(text(req.body?.status, 20));
    if (!UUID.test(id) || !status.success) return res.status(400).type("text/plain").send("Bad Request");
    const user = req.auth!.user;
    // O tenant_id vem da sessão, nunca do pedido: impede mexer em dados de outro cliente.
    if (!(await store.setReservationStatus(user.tenant_id!, id, status.data))) return res.status(404).type("text/plain").send("Not Found");
    await store.audit(user.id, user.tenant_id, "reserva_estado", `${id} ${status.data}`);
    res.redirect(303, "/app/reservas?ok=estado");
  });

  // ---- Resort
  const saveProfile = async (
    req: AuthedRequest,
    res: Response,
    t: Tenant,
    draft: unknown,
    render: (p: V.DraftProfile, f: V.Flash) => string,
    back: string,
  ) => {
    const parsed = ResortSchema.safeParse(draft);
    if (!parsed.success) return html(res, render(draft as V.DraftProfile, { error: profileError(parsed.error) }), 400);
    await store.updateProfile(t.id, parsed.data);
    await store.audit(req.auth!.user.id, t.id, "perfil_alterado", back);
    res.redirect(303, `${back}?ok=guardado`);
  };

  app.get("/app/resort", owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    html(res, V.resortGeneralPage(ctx(req), t.profile, t.reception_phone ?? "", flash(req)));
  });
  app.post("/app/resort", ...post, owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    const b = req.body ?? {};
    const reception = text(b.reception_phone, 16).replace(/\s+/g, "");
    const draft = {
      ...t.profile,
      name: text(b.name, 100),
      address: text(b.address, 200),
      website: text(b.website, 200) || undefined,
      email: text(b.email, 254) || undefined,
      booking_rules: { min_nights: int(b.min_nights), max_nights: int(b.max_nights), max_days_in_advance: int(b.max_days_in_advance) },
    };
    const render = (p: V.DraftProfile, f: V.Flash) => V.resortGeneralPage(ctx(req), p, reception, f);
    if (!E164.test(reception)) return html(res, render(draft, { error: "Telefone da receção: use o formato internacional, por exemplo +351210000000." }), 400);
    if (draft.booking_rules.min_nights > draft.booking_rules.max_nights) return html(res, render(draft, { error: "A estadia mínima não pode ser maior do que a máxima." }), 400);
    const parsed = ResortSchema.safeParse(draft);
    if (parsed.success) await store.updateReception(t.id, reception);
    await saveProfile(req, res, t, draft, render, "/app/resort");
  });

  app.get("/app/resort/quartos", owner, async (req: AuthedRequest, res) => {
    html(res, V.resortRoomsPage(ctx(req), (await tenantOf(req)).profile, flash(req)));
  });
  app.post("/app/resort/quartos", ...post, owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    const b = req.body ?? {};
    const [ids, names, descs, rates, units, adults, children, occ] = [
      list(b.room_id), list(b.room_name), list(b.room_description), list(b.room_rate),
      list(b.room_units), list(b.room_adults), list(b.room_children), list(b.room_occupancy),
    ];
    const used = new Set<string>();
    const rooms: V.DraftRoom[] = [];
    names.forEach((name, i) => {
      if (!name) return; // linha em branco = removida
      let id = /^[a-z0-9_-]{2,40}$/.test(ids[i] ?? "") ? ids[i]! : slug(name);
      while (used.has(id)) id = `${id.slice(0, 36)}_${used.size + 1}`;
      used.add(id);
      rooms.push({
        id, name: name.slice(0, 80), description: (descs[i] ?? "").slice(0, 300),
        nightly_rate_from: dec(rates[i]), units: int(units[i]),
        max_adults: int(adults[i]), max_children: int(children[i]), max_occupancy: int(occ[i]),
      });
    });
    const draft = { ...t.profile, rooms };
    await saveProfile(req, res, t, draft, (p, f) => V.resortRoomsPage(ctx(req), p, f), "/app/resort/quartos");
  });

  app.get("/app/resort/informacao", owner, async (req: AuthedRequest, res) => {
    html(res, V.resortInfoPage(ctx(req), (await tenantOf(req)).profile, flash(req)));
  });
  app.post("/app/resort/informacao", ...post, owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    const b = req.body ?? {};
    const pairs = (a: string[], c: string[]) => a.map((x, i) => [x, c[i] ?? ""] as const).filter(([x, y]) => x || y);
    const policies: Record<string, string> = {};
    for (const [k, v] of pairs(list(b.policy_a), list(b.policy_b))) policies[k.slice(0, 60) || "?"] = v;
    const draft = {
      ...t.profile,
      policies,
      facilities: text(b.facilities, 4000).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 60),
      faq: pairs(list(b.faq_a), list(b.faq_b)).slice(0, 60).map(([q, a]) => ({ q, a })),
    };
    const render = (p: V.DraftProfile, f: V.Flash) => V.resortInfoPage(ctx(req), p, f);
    if (Object.entries(policies).some(([k, v]) => k === "?" || !v)) return html(res, render(draft, { error: "Preencha o tema e o texto de cada política." }), 400);
    if (draft.faq.some((x) => !x.q || !x.a)) return html(res, render(draft, { error: "Preencha a pergunta e a resposta." }), 400);
    await saveProfile(req, res, t, draft, render, "/app/resort/informacao");
  });

  app.get("/app/resort/idiomas", owner, async (req: AuthedRequest, res) => {
    html(res, V.resortLanguagesPage(ctx(req), (await tenantOf(req)).profile, LANGUAGE_OPTIONS, flash(req)));
  });
  app.post("/app/resort/idiomas", ...post, owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    const b = req.body ?? {};
    const chosen = new Set(list(b.lang));
    const primary = text(b.primary, 5);
    chosen.add(primary);
    const languages = LANGUAGE_OPTIONS.filter((o) => chosen.has(o.code))
      .sort((x, y) => Number(y.code === primary) - Number(x.code === primary))
      .map((o) => ({
        code: o.code,
        label: o.label,
        ttsProvider: "Google" as const,
        transcriptionProvider: "Google" as const,
        welcomeGreeting: text(b[`greeting_${o.code}`], 400),
      }));
    const draft = { ...t.profile, languages };
    await saveProfile(req, res, t, draft, (p, f) => V.resortLanguagesPage(ctx(req), p, LANGUAGE_OPTIONS, f), "/app/resort/idiomas");
  });

  // ---- Integrações
  app.get("/app/integracoes", owner, async (req: AuthedRequest, res) => {
    html(res, V.integrationsPage(ctx(req), await tenantOf(req), flash(req)));
  });
  app.post("/app/integracoes", ...post, owner, async (req: AuthedRequest, res) => {
    const t = await tenantOf(req);
    const b = req.body ?? {};
    const webhookUrl = text(b.webhook_url, 300) || null;
    const pmsUrl = (text(b.pms_url, 300) || null)?.replace(/\/+$/, "") ?? null;
    const pmsToken = text(b.pms_token, 300);
    const fail = (error: string) => html(res, V.integrationsPage(ctx(req), { ...t, webhook_url: webhookUrl, pms_url: pmsUrl }, { error }), 400);

    // Anti-SSRF: só destinos HTTPS públicos.
    for (const [label, url] of [["Webhook", webhookUrl], ["API de disponibilidade", pmsUrl]] as const) {
      const err = url ? await publicHttpsUrlError(url, deps.webhookOpts?.resolver) : null;
      if (err) return fail(`${label}: ${err}`);
    }
    const pmsTokenEnc = pmsUrl ? (pmsToken ? deps.crypto.encrypt(pmsToken) : t.pms_token_enc) : null;
    if (pmsUrl && !pmsTokenEnc) return fail("API de disponibilidade: indique o token de acesso.");

    let secretEnc = webhookUrl ? t.webhook_secret_enc : null;
    let newSecret: string | undefined;
    if (webhookUrl && (!secretEnc || text(b.rotate_secret) === "1")) {
      newSecret = randomToken(32);
      secretEnc = deps.crypto.encrypt(newSecret);
    }
    await store.updateIntegrations(t.id, { webhook_url: webhookUrl, webhook_secret_enc: secretEnc, pms_url: pmsUrl, pms_token_enc: pmsTokenEnc });
    await store.audit(req.auth!.user.id, t.id, "integracoes_alteradas");
    if (!newSecret) return res.redirect(303, "/app/integracoes?ok=guardado");
    html(res, V.integrationsPage(ctx(req), (await store.tenantById(t.id))!, { ok: "Alterações guardadas." }, newSecret));
  });

  // ------------------------------------------------------------ Administração
  const admin = guard("admin");

  app.get("/admin", admin, async (req: AuthedRequest, res) => html(res, V.adminTenantsPage(ctx(req), await store.listTenants(), flash(req))));
  app.get("/admin/leads", admin, async (req: AuthedRequest, res) => html(res, V.adminLeadsPage(ctx(req), await store.listLeads())));
  app.get("/admin/clientes/novo", admin, (req: AuthedRequest, res) => html(res, V.adminNewTenantPage(ctx(req), {})));

  const voiceUrl = `${config.PUBLIC_BASE_URL}/voice`;
  const showTenant = async (req: AuthedRequest, res: Response, id: string, f: V.Flash, tempPassword?: string, status = 200) => {
    const t = await store.tenantById(id);
    if (!t) return res.status(404).type("text/plain").send("Not Found");
    html(res, V.adminTenantPage(ctx(req), t, (await store.ownerOf(id))?.email ?? null, voiceUrl, f, tempPassword), status);
  };

  app.post("/admin/clientes/novo", ...post, admin, async (req: AuthedRequest, res) => {
    const name = text(req.body?.name, 100);
    const email = text(req.body?.email, 254).toLowerCase();
    const fail = (error: string) => html(res, V.adminNewTenantPage(ctx(req), { error }, { name, email }), 400);
    if (name.length < 2) return fail("Indique o nome do resort.");
    if (!z.string().email().safeParse(email).success) return fail("Indique um e-mail válido.");
    if (await store.userByEmail(email)) return fail("Já existe uma conta com este e-mail.");
    const profile: Resort = { ...deps.resortTemplate, name };
    const temp = temporaryPassword();
    const id = await store.createTenantWithOwner(name, profile, email, await hashPassword(temp));
    await store.audit(req.auth!.user.id, id, "cliente_criado");
    await showTenant(req, res, id, { ok: "Cliente criado." }, temp);
  });

  app.get("/admin/clientes/:id", admin, async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(404).type("text/plain").send("Not Found");
    await showTenant(req, res, id, flash(req));
  });

  app.post("/admin/clientes/:id", ...post, admin, async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(404).type("text/plain").send("Not Found");
    const b = req.body ?? {};
    const number = text(b.twilio_number, 16).replace(/\s+/g, "") || null;
    const parsed = z
      .object({
        status: z.enum(["active", "suspended"]),
        monthly_minutes_limit: z.number().int().min(0).max(1_000_000),
        max_concurrent_calls: z.number().int().min(1).max(100),
      })
      .safeParse({ status: text(b.status, 12), monthly_minutes_limit: int(b.monthly_minutes_limit), max_concurrent_calls: int(b.max_concurrent_calls) });
    if (!parsed.success) return showTenant(req, res, id, { error: "Verifique os valores introduzidos." }, undefined, 400);
    if (number && !E164.test(number)) return showTenant(req, res, id, { error: "Número Twilio: use o formato internacional, por exemplo +351300000000." }, undefined, 400);
    if (number) {
      const other = await store.tenantByNumber(number);
      if (other && other.id !== id) return showTenant(req, res, id, { error: `Esse número já está atribuído a ${other.name}.` }, undefined, 400);
    }
    await store.updateTenantAdmin(id, { ...parsed.data, twilio_number: number });
    await store.audit(req.auth!.user.id, id, "cliente_alterado", `${parsed.data.status} ${number ?? "sem número"}`);
    res.redirect(303, `/admin/clientes/${id}?ok=guardado`);
  });

  app.post("/admin/clientes/:id/palavra-passe", ...post, admin, async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(404).type("text/plain").send("Not Found");
    const user = await store.ownerOf(id);
    if (!user) return res.status(404).type("text/plain").send("Not Found");
    const temp = temporaryPassword();
    await store.setPassword(user.id, await hashPassword(temp), true);
    await store.audit(req.auth!.user.id, id, "password_reposta");
    await showTenant(req, res, id, { ok: "Palavra-passe reposta." }, temp);
  });
}
