/*
 * Error-message helpers.
 *
 * `explainFsError` maps common Node I/O error codes to actionable
 * recovery hints. The returned string is safe to display to users
 * (no internal paths beyond what the error already contains).
 */

interface CodedError {
  code?: string;
  message?: string;
  path?: string;
  syscall?: string;
}

export function explainFsError(err: unknown, context: string): string {
  const e = err as CodedError;
  const path = e.path ? ` at ${e.path}` : "";
  switch (e.code) {
    case "EACCES":
      return `${context}: permission denied${path}. Fix: check the parent directory's write permissions, or run with sufficient privileges.`;
    case "EPERM":
      return `${context}: operation not permitted${path}. Fix: the file may be locked or owned by another user; check ownership.`;
    case "ENOSPC":
      return `${context}: out of disk space${path}. Fix: free up space and retry.`;
    case "ENOENT":
      return `${context}: file not found${path}. Fix: make sure the starter submodule is initialized (\`git submodule update --init\` in the monorepo root).`;
    case "EEXIST":
      return `${context}: file already exists${path}. Fix: move or remove it, then retry.`;
    case "EROFS":
      return `${context}: filesystem is read-only${path}. Fix: scaffold into a writable location.`;
    case "EMFILE":
    case "ENFILE":
      return `${context}: too many open files. Fix: close other processes or raise \`ulimit -n\`.`;
    default:
      return `${context}: ${e.message ?? String(err)}`;
  }
}
