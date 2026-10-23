import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["node_modules/**", "dist/**", "datas/**", "test-results/**", ".tessera/**"] },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.ts", "scripts/**/*.{ts,mjs,cjs}", "tests/**/*.{ts,mjs}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "constructor-super": "error",
      "valid-typeof": "error",
      "use-isnan": "error",
    },
  },
];
