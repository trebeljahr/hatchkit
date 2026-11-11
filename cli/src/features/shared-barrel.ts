/*
 * The one spelling of a re-export in `packages/shared/src/index.ts`.
 *
 * The web client compiles the shared package from source (its tsconfig maps
 * `@starter/shared` onto `packages/shared/src/`), and Next's Turbopack does not
 * map a `./x.js` specifier onto `./x.ts`. One `.js` line in the barrel
 * therefore fails the client's first runtime import from `@starter/shared` with
 * "Module not found: Can't resolve './x.js'", while every `import type` keeps
 * compiling — so the break surfaces only once a value is imported. The package
 * has no `"type": "module"`, so tsc (NodeNext) treats it as CommonJS, where the
 * extensionless form is valid and the emitted `require("./x")` resolves in
 * `dist/` for the server.
 *
 * Projects scaffolded before this carry `./x.js` lines, so a check for an
 * existing re-export accepts both spellings; a new line is always written
 * extensionless.
 */

/** `export * from "./<module>";` */
export function sharedBarrelExport(module: string): string {
  return `export * from "./${module}";`;
}

/** Does `source` already re-export `./<module>`, with or without `.js`? */
export function hasSharedBarrelExport(source: string, module: string): boolean {
  const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^export \\* from "\\./${escaped}(?:\\.js)?";`, "m").test(source);
}
