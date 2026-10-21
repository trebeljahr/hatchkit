import ora, { type Options } from "ora";

/** Ora cannot clear a terminal with zero columns: disable animation there. */
export default function spinner(options: string | Options = {}) {
  const opts = typeof options === "string" ? { text: options } : options;
  const stream = opts.stream ?? process.stderr;
  return ora({
    ...opts,
    isEnabled:
      opts.isEnabled !== false &&
      "isTTY" in stream &&
      stream.isTTY === true &&
      "columns" in stream &&
      typeof stream.columns === "number" &&
      stream.columns > 0,
  });
}
