import pg from "pg";
import { ResortSchema, type Resort } from "../resort.js";

export type TenantStatus = "active" | "suspended";
export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  twilio_number: string | null;
  reception_phone: string | null;
  profile: Resort;
  webhook_url: string | null;
  webhook_secret_enc: string | null;
  pms_url: string | null;
  pms_token_enc: string | null;
  max_concurrent_calls: number;
  monthly_minutes_limit: number;
  created_at: Date;
}
export interface User {
  id: string;
  tenant_id: string | null;
  email: string;
  password_hash: string;
  role: "owner" | "admin";
  must_change_password: boolean;
  failed_attempts: number;
  locked_until: Date | null;
}
export interface WebSession {
  token_hash: string;
  user_id: string;
  csrf: string;
  expires_at: Date;
}
export interface CallRow {
  id: string;
  call_sid: string;
  caller_hash: string;
  started_at: Date;
  duration_s: number | null;
  turns: number | null;
  outcome: string | null;
  language: string | null;
}
export interface ReservationRow {
  id: string;
  tenant_id: string;
  call_sid: string;
  pii_enc: string | null;
  check_in: string;
  check_out: string;
  room_type: string;
  adults: number;
  children: number;
  quoted_total: string | null;
  currency: string;
  status: "pending" | "confirmed" | "declined";
  delivered: boolean;
  created_at: Date;
}
export interface Lead {
  id: string;
  name: string;
  email: string;
  company: string;
  phone: string | null;
  message: string | null;
  created_at: Date;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    twilio_number text UNIQUE,
    reception_phone text,
    profile jsonb NOT NULL,
    webhook_url text,
    webhook_secret_enc text,
    pms_url text,
    pms_token_enc text,
    max_concurrent_calls int NOT NULL DEFAULT 5,
    monthly_minutes_limit int NOT NULL DEFAULT 500,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner','admin')),
    must_change_password boolean NOT NULL DEFAULT false,
    failed_attempts int NOT NULL DEFAULT 0,
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((role = 'admin') = (tenant_id IS NULL))
  );
  CREATE TABLE web_sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf text NOT NULL,
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    call_sid text NOT NULL UNIQUE,
    caller_hash text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    duration_s int,
    turns int,
    outcome text,
    language text
  );
  CREATE INDEX calls_tenant_started ON calls (tenant_id, started_at DESC);
  CREATE TABLE reservation_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    call_sid text NOT NULL,
    pii_enc text,
    check_in date NOT NULL,
    check_out date NOT NULL,
    room_type text NOT NULL,
    adults int NOT NULL,
    children int NOT NULL,
    quoted_total numeric(10,2),
    currency text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined')),
    delivered boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX reservations_tenant_created ON reservation_requests (tenant_id, created_at DESC);
  CREATE TABLE leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email text NOT NULL,
    company text NOT NULL,
    phone text,
    message text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    user_id uuid,
    tenant_id uuid,
    action text NOT NULL,
    detail text
  );
  `,
];

function toTenant(row: Record<string, unknown>): Tenant {
  return { ...(row as unknown as Tenant), profile: ResortSchema.parse(row.profile) };
}

export class Store {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string, ssl: boolean) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  private async q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(text, params)).rows;
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(727274)");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const done = new Set((await client.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
      for (const [i, sql] of MIGRATIONS.entries()) {
        if (done.has(i + 1)) continue;
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [i + 1]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
  async close(): Promise<void> {
    await this.pool.end();
  }

  // ---------- Tenants ----------
  async tenantById(id: string): Promise<Tenant | null> {
    const r = await this.q("SELECT * FROM tenants WHERE id = $1", [id]);
    return r[0] ? toTenant(r[0]) : null;
  }
  async tenantByNumber(number: string): Promise<Tenant | null> {
    const r = await this.q("SELECT * FROM tenants WHERE twilio_number = $1", [number]);
    return r[0] ? toTenant(r[0]) : null;
  }
  async listTenants(): Promise<Array<Tenant & { minutes_used: number; owner_email: string | null }>> {
    const rows = await this.q(
      `SELECT t.*,
        COALESCE((SELECT CEIL(SUM(duration_s) / 60.0) FROM calls c WHERE c.tenant_id = t.id AND c.started_at >= date_trunc('month', now())), 0)::int AS minutes_used,
        (SELECT email FROM users u WHERE u.tenant_id = t.id ORDER BY u.created_at LIMIT 1) AS owner_email
       FROM tenants t ORDER BY t.created_at DESC`,
    );
    return rows.map((r) => ({ ...toTenant(r), minutes_used: r.minutes_used as number, owner_email: r.owner_email as string | null }));
  }
  /** Cria o cliente e o utilizador dono numa transação. */
  async createTenantWithOwner(name: string, profile: Resort, email: string, passwordHash: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const t = await client.query<{ id: string }>("INSERT INTO tenants (name, profile) VALUES ($1, $2) RETURNING id", [
        name,
        JSON.stringify(profile),
      ]);
      await client.query(
        "INSERT INTO users (tenant_id, email, password_hash, role, must_change_password) VALUES ($1, $2, $3, 'owner', true)",
        [t.rows[0]!.id, email, passwordHash],
      );
      await client.query("COMMIT");
      return t.rows[0]!.id;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async updateProfile(tenantId: string, profile: Resort): Promise<void> {
    await this.q("UPDATE tenants SET profile = $2, name = $3 WHERE id = $1", [tenantId, JSON.stringify(profile), profile.name]);
  }
  async updateReception(tenantId: string, phone: string | null): Promise<void> {
    await this.q("UPDATE tenants SET reception_phone = $2 WHERE id = $1", [tenantId, phone]);
  }
  async updateIntegrations(
    tenantId: string,
    v: { webhook_url: string | null; webhook_secret_enc: string | null; pms_url: string | null; pms_token_enc: string | null },
  ): Promise<void> {
    await this.q("UPDATE tenants SET webhook_url=$2, webhook_secret_enc=$3, pms_url=$4, pms_token_enc=$5 WHERE id=$1", [
      tenantId, v.webhook_url, v.webhook_secret_enc, v.pms_url, v.pms_token_enc,
    ]);
  }
  async updateTenantAdmin(
    tenantId: string,
    v: { status: TenantStatus; twilio_number: string | null; max_concurrent_calls: number; monthly_minutes_limit: number },
  ): Promise<void> {
    await this.q("UPDATE tenants SET status=$2, twilio_number=$3, max_concurrent_calls=$4, monthly_minutes_limit=$5 WHERE id=$1", [
      tenantId, v.status, v.twilio_number, v.max_concurrent_calls, v.monthly_minutes_limit,
    ]);
  }

  // ---------- Utilizadores e sessões ----------
  async userByEmail(email: string): Promise<User | null> {
    return (await this.q<User>("SELECT * FROM users WHERE email = $1", [email]))[0] ?? null;
  }
  async userById(id: string): Promise<User | null> {
    return (await this.q<User>("SELECT * FROM users WHERE id = $1", [id]))[0] ?? null;
  }
  async ownerOf(tenantId: string): Promise<User | null> {
    return (await this.q<User>("SELECT * FROM users WHERE tenant_id = $1 ORDER BY created_at LIMIT 1", [tenantId]))[0] ?? null;
  }
  async ensureAdmin(email: string, passwordHash: string): Promise<boolean> {
    const r = await this.q(
      "INSERT INTO users (email, password_hash, role, must_change_password) VALUES ($1, $2, 'admin', true) ON CONFLICT (email) DO NOTHING RETURNING id",
      [email, passwordHash],
    );
    return r.length > 0;
  }
  async adminExists(): Promise<boolean> {
    return (await this.q("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1")).length > 0;
  }
  async setPassword(userId: string, hash: string, mustChange: boolean): Promise<void> {
    await this.q("UPDATE users SET password_hash=$2, must_change_password=$3, failed_attempts=0, locked_until=NULL WHERE id=$1", [
      userId, hash, mustChange,
    ]);
    await this.q("DELETE FROM web_sessions WHERE user_id = $1", [userId]);
  }
  /** 8 falhas seguidas bloqueiam a conta durante 15 minutos. */
  async recordLoginFailure(userId: string): Promise<void> {
    await this.q(
      `UPDATE users SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN failed_attempts + 1 >= 8 THEN now() + interval '15 minutes' ELSE locked_until END
       WHERE id = $1`,
      [userId],
    );
  }
  async recordLoginSuccess(userId: string): Promise<void> {
    await this.q("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [userId]);
  }
  async createSession(tokenHash: string, userId: string, csrf: string, ttlHours: number): Promise<void> {
    await this.q("INSERT INTO web_sessions (token_hash, user_id, csrf, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))", [
      tokenHash, userId, csrf, ttlHours,
    ]);
  }
  async sessionByHash(tokenHash: string): Promise<WebSession | null> {
    return (await this.q<WebSession>("SELECT * FROM web_sessions WHERE token_hash = $1 AND expires_at > now()", [tokenHash]))[0] ?? null;
  }
  async deleteSession(tokenHash: string): Promise<void> {
    await this.q("DELETE FROM web_sessions WHERE token_hash = $1", [tokenHash]);
  }

  // ---------- Chamadas ----------
  async startCall(tenantId: string, callSid: string, callerHash: string): Promise<void> {
    await this.q("INSERT INTO calls (tenant_id, call_sid, caller_hash) VALUES ($1,$2,$3) ON CONFLICT (call_sid) DO NOTHING", [
      tenantId, callSid, callerHash,
    ]);
  }
  async endCall(callSid: string, v: { duration_s: number; turns: number; outcome: string; language: string }): Promise<void> {
    await this.q("UPDATE calls SET duration_s=$2, turns=$3, outcome=$4, language=$5 WHERE call_sid=$1", [
      callSid, v.duration_s, v.turns, v.outcome, v.language,
    ]);
  }
  async listCalls(tenantId: string, limit = 100): Promise<CallRow[]> {
    return this.q<CallRow>("SELECT * FROM calls WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2", [tenantId, limit]);
  }
  async monthStats(tenantId: string): Promise<{ calls: number; minutes: number; transferred: number; pending: number; requests: number }> {
    const r = await this.q<{ calls: number; minutes: number; transferred: number; pending: number; requests: number }>(
      `SELECT
        (SELECT COUNT(*) FROM calls WHERE tenant_id=$1 AND started_at >= date_trunc('month', now()))::int AS calls,
        COALESCE((SELECT CEIL(SUM(duration_s)/60.0) FROM calls WHERE tenant_id=$1 AND started_at >= date_trunc('month', now())),0)::int AS minutes,
        (SELECT COUNT(*) FROM calls WHERE tenant_id=$1 AND outcome='transfer' AND started_at >= date_trunc('month', now()))::int AS transferred,
        (SELECT COUNT(*) FROM reservation_requests WHERE tenant_id=$1 AND status='pending')::int AS pending,
        (SELECT COUNT(*) FROM reservation_requests WHERE tenant_id=$1 AND created_at >= date_trunc('month', now()))::int AS requests`,
      [tenantId],
    );
    return r[0]!;
  }

  // ---------- Pedidos de reserva ----------
  async insertReservation(v: {
    tenant_id: string; call_sid: string; pii_enc: string; check_in: string; check_out: string; room_type: string;
    adults: number; children: number; quoted_total: number | null; currency: string;
  }): Promise<string> {
    const r = await this.q<{ id: string }>(
      `INSERT INTO reservation_requests (tenant_id, call_sid, pii_enc, check_in, check_out, room_type, adults, children, quoted_total, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [v.tenant_id, v.call_sid, v.pii_enc, v.check_in, v.check_out, v.room_type, v.adults, v.children, v.quoted_total, v.currency],
    );
    return r[0]!.id;
  }
  async markDelivered(id: string): Promise<void> {
    await this.q("UPDATE reservation_requests SET delivered = true WHERE id = $1", [id]);
  }
  async listReservations(tenantId: string, limit = 100): Promise<ReservationRow[]> {
    return this.q<ReservationRow>(
      `SELECT id, tenant_id, call_sid, pii_enc, to_char(check_in,'YYYY-MM-DD') AS check_in, to_char(check_out,'YYYY-MM-DD') AS check_out,
              room_type, adults, children, quoted_total, currency, status, delivered, created_at
       FROM reservation_requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
  }
  /** O tenant_id na condição impede alterar pedidos de outro cliente. */
  async setReservationStatus(tenantId: string, id: string, status: "pending" | "confirmed" | "declined"): Promise<boolean> {
    const r = await this.pool.query("UPDATE reservation_requests SET status=$3 WHERE id=$2 AND tenant_id=$1", [tenantId, id, status]);
    return (r.rowCount ?? 0) > 0;
  }

  // ---------- Leads, auditoria, retenção ----------
  async insertLead(v: { name: string; email: string; company: string; phone: string | null; message: string | null }): Promise<void> {
    await this.q("INSERT INTO leads (name, email, company, phone, message) VALUES ($1,$2,$3,$4,$5)", [
      v.name, v.email, v.company, v.phone, v.message,
    ]);
  }
  async listLeads(limit = 50): Promise<Lead[]> {
    return this.q<Lead>("SELECT * FROM leads ORDER BY created_at DESC LIMIT $1", [limit]);
  }
  async audit(userId: string | null, tenantId: string | null, action: string, detail = ""): Promise<void> {
    await this.q("INSERT INTO audit_log (user_id, tenant_id, action, detail) VALUES ($1,$2,$3,$4)", [userId, tenantId, action, detail.slice(0, 300)]);
  }
  /** RGPD: apaga dados pessoais antigos. Devolve o nº de pedidos anonimizados. */
  async purge(retentionDays: number): Promise<number> {
    const r = await this.pool.query(
      "UPDATE reservation_requests SET pii_enc = NULL WHERE pii_enc IS NOT NULL AND created_at < now() - make_interval(days => $1)",
      [retentionDays],
    );
    await this.q("DELETE FROM web_sessions WHERE expires_at < now()");
    await this.q("DELETE FROM leads WHERE created_at < now() - interval '365 days'");
    await this.q("DELETE FROM audit_log WHERE at < now() - interval '365 days'");
    return r.rowCount ?? 0;
  }
}
