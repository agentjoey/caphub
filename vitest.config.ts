import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "lib/**/*.test.ts",
      "scripts/**/*.test.ts",
      "components/**/*.test.{ts,tsx}",
      "app/**/*.test.{ts,tsx}"
    ],
    environment: "node"
  },
  resolve: { alias: { "server-only": new URL("./lib/test/server-only.ts", import.meta.url).pathname } }
});
