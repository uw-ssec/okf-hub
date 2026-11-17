import { configDefaults, defineConfig } from "vitest/config";

// Integration tests need the services in compose.test.yml, so the default run
// leaves them out. `npm run test:integration` runs only them.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/*.integration.test.ts"] },
});
