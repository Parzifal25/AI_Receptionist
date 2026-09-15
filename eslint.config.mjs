import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Interface-completing parameters intentionally left unused are marked with
  // a leading underscore (e.g. `supports(_channel)`), the codebase-wide
  // convention; the rule still flags genuinely unused variables.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // HALO dependency rule (plan §2.4 rule 2): packages/* must never import
  // from the application (src/, alias @/*). Enforced in lint, not by
  // convention. Tightens as each package lands in sub-phase 1a.
  {
    files: ["packages/**/*.{ts,tsx,mts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*"],
              message: "packages/* must not import from the application (src/). HALO Core stays business-agnostic and depends only on other packages.",
            },
            {
              group: ["**/src/**"],
              message: "packages/* must not import app files via relative paths. HALO Core depends only on other packages.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated widget bundle (built from widget/src by scripts/build-widget.mjs).
    "public/widget.js",
  ]),
]);

export default eslintConfig;
