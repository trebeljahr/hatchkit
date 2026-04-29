/**
 * Multi-select prompt with intuitive keybindings:
 *   ↑↓     navigate
 *   Enter  toggle the highlighted option
 *   Tab    submit (advance to the next prompt)
 *   Space  also toggles (kept as an alias for inquirer-muscle-memory)
 *
 * Built on @inquirer/core so it composes with the rest of the
 * @inquirer/prompts the CLI already uses (input/select/confirm). The
 * vanilla `checkbox` from @inquirer/prompts uses Space=toggle +
 * Enter=submit, which conflicts with the rest of the flow where Enter
 * is the universal "go" key — this swap makes Enter behave consistently
 * (it always advances state on the current prompt) and Tab moves to the
 * next prompt, which is the same convention as web forms.
 */
import {
  Separator,
  ValidationError,
  createPrompt,
  isDownKey,
  isEnterKey,
  isNumberKey,
  isSpaceKey,
  isTabKey,
  isUpKey,
  makeTheme,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useState,
} from "@inquirer/core";
import figures from "@inquirer/figures";
import chalk from "chalk";

export interface MultiselectChoice<Value> {
  value: Value;
  name?: string;
  description?: string;
  disabled?: boolean | string;
  checked?: boolean;
}

export interface MultiselectConfig<Value> {
  message: string;
  choices: ReadonlyArray<Separator | MultiselectChoice<Value>>;
  pageSize?: number;
  loop?: boolean;
  required?: boolean;
}

interface NormalizedChoice {
  value: unknown;
  name: string;
  description?: string;
  disabled: boolean | string;
  checked: boolean;
}

type Item = Separator | NormalizedChoice;

function isSelectable(item: Item): item is NormalizedChoice {
  return !Separator.isSeparator(item) && !item.disabled;
}

function normalize(choices: ReadonlyArray<Separator | MultiselectChoice<unknown>>): Item[] {
  return choices.map((c): Item => {
    if (Separator.isSeparator(c)) return c;
    const name = c.name ?? String(c.value);
    return {
      value: c.value,
      name,
      description: c.description,
      disabled: c.disabled ?? false,
      checked: c.checked ?? false,
    };
  });
}

interface InternalConfig {
  message: string;
  choices: ReadonlyArray<Separator | MultiselectChoice<unknown>>;
  pageSize?: number;
  loop?: boolean;
  required?: boolean;
}

const corePrompt = createPrompt<unknown[], InternalConfig>((config, done) => {
  const { pageSize = 10, loop = true, required = false } = config;
  const theme = makeTheme();
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const prefix = usePrefix({ status, theme });
  const [items, setItems] = useState<Item[]>(normalize(config.choices));
  const bounds = useMemo(() => {
    const first = items.findIndex(isSelectable);
    let last = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (isSelectable(items[i])) {
        last = i;
        break;
      }
    }
    if (first === -1) {
      throw new ValidationError("[multiselect] No selectable choices.");
    }
    return { first, last };
  }, [items]);
  const [active, setActive] = useState(bounds.first);
  const [errorMsg, setError] = useState<string | undefined>();

  const toggleAt = (index: number) => {
    setError(undefined);
    setItems(
      items.map((c, i) => {
        if (i !== index) return c;
        if (!isSelectable(c)) return c;
        return { ...c, checked: !c.checked };
      }),
    );
  };

  useKeypress((key) => {
    if (isTabKey(key)) {
      const selection = items.filter((c): c is NormalizedChoice => isSelectable(c) && c.checked);
      if (required && selection.length === 0) {
        setError("Pick at least one (use Enter to toggle).");
        return;
      }
      setStatus("done");
      done(selection.map((c) => c.value));
      return;
    }
    if (isEnterKey(key) || isSpaceKey(key)) {
      toggleAt(active);
      return;
    }
    if (isUpKey(key) || isDownKey(key)) {
      if (
        loop ||
        (isUpKey(key) && active !== bounds.first) ||
        (isDownKey(key) && active !== bounds.last)
      ) {
        const offset = isUpKey(key) ? -1 : 1;
        let next = active;
        do {
          next = (next + offset + items.length) % items.length;
        } while (!isSelectable(items[next]));
        setActive(next);
      }
      return;
    }
    if (isNumberKey(key)) {
      const idx = Number(key.name) - 1;
      let seen = -1;
      const pos = items.findIndex((it) => {
        if (Separator.isSeparator(it)) return false;
        seen++;
        return seen === idx;
      });
      if (pos !== -1 && isSelectable(items[pos])) {
        setActive(pos);
        toggleAt(pos);
      }
    }
  });

  const message = theme.style.message(config.message, status);

  if (status === "done") {
    const selected = items.filter((c): c is NormalizedChoice => isSelectable(c) && c.checked);
    const tail = selected.length > 0 ? selected.map((c) => c.name).join(", ") : chalk.dim("none");
    return `${prefix} ${message} ${theme.style.answer(tail)}`;
  }

  let description: string | undefined;
  const page = usePagination({
    items,
    active,
    renderItem({ item, isActive }: { item: Item; isActive: boolean }) {
      if (Separator.isSeparator(item)) return ` ${item.separator}`;
      if (item.disabled) {
        const label = typeof item.disabled === "string" ? item.disabled : "(disabled)";
        return chalk.dim(`- ${item.name} ${label}`);
      }
      if (isActive) description = item.description;
      const box = item.checked ? chalk.green(figures.circleFilled) : figures.circle;
      const cursor = isActive ? figures.pointer : " ";
      const line = `${cursor}${box} ${item.name}`;
      return isActive ? theme.style.highlight(line) : line;
    },
    pageSize,
    loop,
  });

  const help = chalk.dim(
    `${chalk.bold("↑↓")} navigate · ${chalk.bold("enter")} toggle · ${chalk.bold("tab")} submit`,
  );

  return [
    `${prefix} ${message}`,
    page,
    " ",
    description ? chalk.cyan(description) : "",
    errorMsg ? theme.style.error(errorMsg) : "",
    help,
  ]
    .filter(Boolean)
    .join("\n")
    .trimEnd();
});

/** Typed wrapper that gives back `Value[]` for callers. */
export function multiselect<Value>(config: MultiselectConfig<Value>): Promise<Value[]> {
  return corePrompt(config as InternalConfig) as Promise<Value[]>;
}

export { Separator };
