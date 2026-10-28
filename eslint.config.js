// ESLint configuration:  npm install && npm run lint
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["web/vendor/**", "demo-files/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.browser, ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-control-regex": "off",        // textmatch.js matches control characters on purpose
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
];
