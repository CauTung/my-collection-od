import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Phase 1: no test files yet — will be available after Phase 2
    // Set to true temporarily; will be set to false after all test files are created
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["app/lib/**/*.server.ts"],
    },
  },
  resolve: {
    alias: {
      // Sync with tsconfig.json paths: ~/* → ./app/*
      "~": new URL("./app", import.meta.url).pathname,
    },
  },
});
