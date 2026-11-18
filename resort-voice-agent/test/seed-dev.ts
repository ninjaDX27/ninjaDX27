// Prepara uma base de dados local com um resort, para testes manuais.
import { PgDb } from "../src/db/driver.js";
import { Store } from "../src/db/store.js";
import { seedTenant } from "./helpers.js";
const store = new Store(new PgDb(process.argv[2]!, false));
await store.migrate();
const id = await seedTenant(store, "Quinta do Mar Resort", "dono@example.test", "+351300000001");
console.log("resort", id);
await store.close();
