import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
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
