// @ts-check
// ESLint flat config for turnstile. Kept minimal per the repo's dependency
// ethos: eslint recommended + typescript-eslint recommended, no stylistic
// rules (formatting is Prettier's job).
import eslint from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["node_modules/"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      // Underscore-prefixed params mark intentionally unused arguments
      // (e.g. createTurnstile's kept-for-shape host param).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The `any` in the Host wire type is deliberate: the host does not
    // expose stable payload types (types.ts promises "any ends here").
    // Fake-host test payloads are loose for the same reason. Everywhere
    // else `any` is a violation.
    files: ["src/types.ts", "tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
)
