/*
 * `hatchkit completion <shell>` — print a shell-completion script.
 *
 * These are static generators (no runtime dispatch into the CLI), so
 * tab-complete is instant and safe to source even before the CLI has
 * been configured. When a new subcommand is added, update the
 * `TOP_LEVEL` / `CONFIG_ADD` / `KEYS_SUB` constants in one place and
 * all three shells regenerate.
 */

const TOP_LEVEL = [
  "setup",
  "init",
  "status",
  "doctor",
  "explain",
  "create",
  "adopt",
  "update",
  "add",
  "keys",
  "config",
  "completion",
  "help",
] as const;

const CONFIG_ADD = [
  "coolify",
  "ghcr",
  "hetzner",
  "dns",
  "s3",
  "modal",
  "runpod",
  "hf",
  "replicate",
  "glitchtip",
  "openpanel",
  "resend",
  "stripe",
] as const;

const CONFIG_SUB = ["add", "reset"] as const;
const KEYS_SUB = ["show", "push"] as const;
const SHELLS = ["zsh", "bash", "fish"] as const;

export function renderCompletion(shell: "zsh" | "bash" | "fish"): string {
  if (shell === "zsh") return zsh();
  if (shell === "bash") return bash();
  return fish();
}

function zsh(): string {
  return `#compdef hatchkit
# zsh completion for hatchkit
# Install:
#   hatchkit completion zsh > ~/.zsh/completions/_hatchkit
#   (ensure that dir is in your \$fpath, then \`compinit\`)

_hatchkit() {
  local -a commands
  commands=(
${TOP_LEVEL.map((c) => `    '${c}:${topDesc(c)}'`).join("\n")}
  )

  local curcontext="$curcontext" state line
  _arguments -C \\
    '1: :->cmds' \\
    '2: :->sub' \\
    '*: :->rest'

  case $state in
    cmds)
      _describe -t commands 'hatchkit command' commands
      ;;
    sub)
      case \${words[2]} in
        config)
          _values 'config subcommand' ${CONFIG_SUB.map((s) => `'${s}'`).join(" ")}
          ;;
        keys)
          _values 'keys subcommand' ${KEYS_SUB.map((s) => `'${s}'`).join(" ")}
          ;;
        completion)
          _values 'shell' ${SHELLS.map((s) => `'${s}'`).join(" ")}
          ;;
        help)
          _values 'topic' ${TOP_LEVEL.map((c) => `'${c}'`).join(" ")}
          ;;
      esac
      ;;
    rest)
      case "\${words[2]} \${words[3]}" in
        'config add')
          _values 'provider' ${CONFIG_ADD.map((p) => `'${p}'`).join(" ")}
          ;;
      esac
      ;;
  esac
}

compdef _hatchkit hatchkit
`;
}

function bash(): string {
  return `# bash completion for hatchkit
# Install:
#   hatchkit completion bash > /usr/local/etc/bash_completion.d/hatchkit
#   # or source inline:  eval "$(hatchkit completion bash)"

_hatchkit_complete() {
  local cur prev words cword
  _init_completion || return

  local top="${TOP_LEVEL.join(" ")}"
  local config_sub="${CONFIG_SUB.join(" ")}"
  local keys_sub="${KEYS_SUB.join(" ")}"
  local shells="${SHELLS.join(" ")}"
  local providers="${CONFIG_ADD.join(" ")}"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$top" -- "$cur") )
    return
  fi

  case "\${words[1]}" in
    config)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$config_sub" -- "$cur") )
      elif [[ $cword -eq 3 && "\${words[2]}" == "add" ]]; then
        COMPREPLY=( $(compgen -W "$providers" -- "$cur") )
      fi
      ;;
    keys)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$keys_sub" -- "$cur") )
      fi
      ;;
    completion)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$shells" -- "$cur") )
      fi
      ;;
    help)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$top" -- "$cur") )
      fi
      ;;
  esac
}

complete -F _hatchkit_complete hatchkit
`;
}

function fish(): string {
  const lines: string[] = [];
  lines.push("# fish completion for hatchkit");
  lines.push("# Install:");
  lines.push("#   hatchkit completion fish > ~/.config/fish/completions/hatchkit.fish");
  lines.push("");
  lines.push(`complete -c hatchkit -f`);
  for (const c of TOP_LEVEL) {
    lines.push(`complete -c hatchkit -n "__fish_use_subcommand" -a "${c}" -d "${topDesc(c)}"`);
  }
  lines.push("");
  for (const s of CONFIG_SUB) {
    lines.push(`complete -c hatchkit -n "__fish_seen_subcommand_from config" -a "${s}"`);
  }
  for (const p of CONFIG_ADD) {
    lines.push(
      `complete -c hatchkit -n "__fish_seen_subcommand_from config; and __fish_seen_subcommand_from add" -a "${p}"`,
    );
  }
  for (const s of KEYS_SUB) {
    lines.push(`complete -c hatchkit -n "__fish_seen_subcommand_from keys" -a "${s}"`);
  }
  for (const s of SHELLS) {
    lines.push(`complete -c hatchkit -n "__fish_seen_subcommand_from completion" -a "${s}"`);
  }
  for (const t of TOP_LEVEL) {
    lines.push(`complete -c hatchkit -n "__fish_seen_subcommand_from help" -a "${t}"`);
  }
  lines.push("");
  return lines.join("\n");
}

function topDesc(cmd: string): string {
  switch (cmd) {
    case "setup":
    case "init":
      return "One-time onboarding — configure every credential";
    case "status":
      return "Show which providers are configured and what's next";
    case "doctor":
      return "Health-check every configured provider";
    case "explain":
      return "One-page mental model of the CLI";
    case "create":
      return "Scaffold a new project";
    case "adopt":
      return "Adopt an existing project (run in project dir)";
    case "update":
      return "Add features to an already-scaffolded project";
    case "add":
      return "Provision GlitchTip / OpenPanel / Resend clients";
    case "keys":
      return "Manage per-project dotenvx private keys";
    case "config":
      return "Manage provider credentials";
    case "completion":
      return "Print a shell-completion script";
    case "help":
      return "Show help for a command";
    default:
      return "";
  }
}
