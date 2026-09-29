/*
 * Small YAML helpers for GitHub Actions workflows: line ranges, not a
 * parser. Shared by the verified-deploy retrofits
 * (features/verified-deploy/workflow.ts) and the signed-deploy retrofit
 * (scaffold/signed-deploy.ts).
 *
 * Deliberately textual. The generated workflow carries long comment
 * blocks that explain which failure each step prevents, and a YAML
 * round-trip drops every one of them. These transforms edit lines and
 * leave everything they did not touch byte for byte.
 */

/** Indentation width of a line. */
export function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Line range `[start, end)` of the job named `job`, body included.
 *  Undefined when there is no such job. */
export function jobRange(lines: string[], job: string): [number, number] | undefined {
  const start = lines.findIndex((line) => new RegExp(`^  ${job}:\\s*$`).test(line));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= 2) {
      end = i;
      break;
    }
  }
  return [start, end];
}

/** Line range `[start, end)` of the step whose `- name:` line contains
 *  `marker`, including the comment block attached above it. */
export function stepRange(
  lines: string[],
  marker: string,
  from: number,
  to: number,
): [number, number] | undefined {
  let at = -1;
  for (let i = from; i < to; i++) {
    if (lines[i].includes(marker)) {
      at = i;
      break;
    }
  }
  if (at === -1) return undefined;
  const indent = indentOf(lines[at]);

  // Walk up over the comment block that explains this step. It belongs
  // to the step, and leaving it behind turns a removal into a paragraph
  // of prose about a step that is no longer there.
  let start = at;
  while (start - 1 >= from) {
    const above = lines[start - 1];
    if (above.trim().startsWith("#") && indentOf(above) === indent) start -= 1;
    else break;
  }

  let end = at + 1;
  for (let i = at + 1; i < to; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= indent) break;
    end = i + 1;
  }
  return [start, end];
}
