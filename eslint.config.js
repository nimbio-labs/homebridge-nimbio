import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Nested globs, not bare `dist/**`: a git worktree under .claude/ carries
    // its own built dist/ and node_modules/, and linting another checkout's
    // build output fails on code we never wrote.
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", ".claude/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JS/ESM example + config files: give them Node globals so `no-undef`
    // doesn't flag process/console/require (the .ts files get these from @types/node).
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
