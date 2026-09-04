import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default tseslint.config(
  js.configs.recommended,
  // Type-checked rules for .server.ts files only (need tsconfig)
  {
    files: ["app/lib/**/*.server.ts", "app/config/**/*.ts", "app/types/**/*.ts", "tests/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      // Critical: no floating promises — enforce in server modules
      "@typescript-eslint/no-floating-promises": "error",
      // Require await on async functions that return promises
      "@typescript-eslint/require-await": "warn",
    },
  },
  // Basic (non-type-checked) rules for all other TS/TSX files
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["app/lib/**/*.server.ts", "app/config/**/*.ts", "app/types/**/*.ts", "tests/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    ignores: [
      "node_modules/**",
      "build/**",
      ".react-router/**",
      "coverage/**",
      "scripts/**", // setup scripts are run standalone, not linted
    ],
  }
);
