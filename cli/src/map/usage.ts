/* Usage text for `hatchkit map`, importable without loading the command. */
export const MAP_USAGE = `Usage: hatchkit map [--out <file>] [--open] [--json]
                    [--extras <file>] [--stack-dir <dir>] [--no-ssh] [--no-github]

Reads every configured provider, the backup hosts' timers, the tailnet,
launchd jobs and local repos, merges the extras registry, and writes one
HTML page: places, connections, projects, background jobs and loose ends,
each piece marked listed / set up by hatchkit / outside hatchkit.

  --out <file>       Where to write the page (default: map/hatchkit-map.html
                     next to hatchkit's config file)
  --open             Open the page when it is written
  --json             Print the map as JSON instead of writing HTML
  --extras <file>    Extras registry (default: $HATCHKIT_MAP_EXTRAS, else
                     ~/.config/hatchkit/map-extras.yaml)
  --stack-dir <dir>  infra/terraform/stacks to read workspaces from
  --no-ssh           Skip reading timers on backup hosts (tailscale ssh)
  --no-github        Skip counting GitHub repos through gh

Every provider call is a GET; host reads are systemctl show. With
TAILSCALE_API_KEY set, the tailnet policy's grants become edges.`;
