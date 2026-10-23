/** Validate the visibility before adopt can begin any interactive or remote work. */
export function parseGithubVisibility(value: string | undefined): "private" | "public" | undefined {
  if (value === undefined || value === "private" || value === "public") return value;
  throw new Error("Invalid --github-visibility. Use private or public.");
}

/** Flags can precede the optional signing project directory. */
export function signingProjectArgument(args: string[]): string {
  const values = new Set(["--platforms", "--bundle-id", "--app-name", "--repo"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (values.has(args[i])) {
      i++;
      continue;
    }
    if (args[i].startsWith("--")) continue;
    positional.push(args[i]);
  }
  if (positional.length > 1)
    throw new Error("Expected at most one project directory for signing apply.");
  return positional[0] ?? ".";
}

/** An existing remote's visibility is authoritative; new repositories are private by default. */
export function adoptRepositoryIsPrivate(
  existing: boolean | undefined,
  requested?: "private" | "public",
): boolean {
  return existing ?? requested !== "public";
}
