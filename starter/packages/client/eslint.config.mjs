import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "node_modules/**", "eslint.config.mjs"]),
  {
    rules: {
      // `pnpm run lint` runs at --max-warnings 0, and a gate only works while
      // it is green: one rule that fires on code nobody intends to change
      // trains everyone to ignore the whole thing.
      //
      // This rule asks for `next/image` instead of `<img>`. The client here
      // builds as a static export with `images: { unoptimized: true }` — the
      // desktop and mobile shells load it from a file:// origin with no Next
      // server behind it — so `next/image` does no optimisation and only adds
      // a wrapper. The <img> tags it flags also render blob: and data: URLs
      // produced at run time, which `next/image` cannot size ahead of time.
      //
      // A project that deploys only to the web and wants the optimiser can
      // delete this block.
      "@next/next/no-img-element": "off",

      // An underscore prefix is how this codebase says "required by the
      // signature, deliberately unused" — a destructured `_reject`, a
      // placeholder parameter before the one that matters. The rule's default
      // has no opinion on the convention, so it reports every one of them and
      // the gate (`--max-warnings 0`) turns red on a naming choice.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default config;
