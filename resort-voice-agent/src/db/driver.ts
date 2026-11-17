import pg from "pg";

/** Interface mínima comum ao Postgres (servidor) e ao PGlite (embutido, versão para PC). */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Vários comandos SQL sem parâmetros (migrações). */
  exec(sql: string): Promise<void>;
}
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PgDb implements Db {
  readonly pool: pg.Pool;

  constructor(url: string, ssl: boolean) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  async query<T>(text: string, params: unknown[] = []) {
    const r = await this.pool.query(text, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      query: async <R>(text: string, params: unknown[] = []) => {
        const r = await client.query(text, params);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
      },
      exec: async (sql: string) => {
        await client.query(sql);
      },
    };
    try {
      await client.query("BEGIN");
      const out = await fn(tx);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

/** Estrutura do PGlite que usamos (evita importar o pacote no servidor). */
interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PGliteTxLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
interface PGliteTxLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

const wrapTx = (t: PGliteTxLike): Queryable => ({
  query: async <T>(text: string, params: unknown[] = []) => {
    const r = await t.query<T>(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  },
  exec: async (sql: string) => {
    await t.exec(sql);
  },
});

export class PgliteDb implements Db {
  private readonly q: Queryable;
  /** O PGlite tem uma só ligação: serializamos as operações para evitar intercalar transações. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PGliteLike) {
    this.q = wrapTx(db);
  }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
  query<T>(text: string, params: unknown[] = []) {
    return this.run(() => this.q.query<T>(text, params));
  }
  exec(sql: string) {
    return this.run(() => this.q.exec(sql));
  }
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.run(() => this.db.transaction((t) => fn(wrapTx(t))));
  }
  close() {
    return this.run(() => this.db.close());
  }
}
