import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@halo": path.resolve(__dirname, "packages"),
      // Unit tests exercise server modules directly; the Next.js
      // "server-only" guard is irrelevant here.
      "server-only": path.resolve(__dirname, "tests/mocks/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Hermetic test env: server modules validate configuration at first
    // access, so the required variables get placeholder values before any
    // test module loads (see tests/setup-env.ts).
    setupFiles: ["tests/setup-env.ts"],
  },
});
