import { defineConfig } from "vitest/config";

// Os testes partilham uma base de dados Postgres: correm um ficheiro de cada vez.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 15000, hookTimeout: 30000 } });
