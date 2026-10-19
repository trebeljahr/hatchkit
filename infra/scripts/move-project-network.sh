#!/usr/bin/env bash
# Move one Coolify project off the shared `coolify` network onto its own
# `hk-<project>` destination, on the Coolify host, as root. The procedure is
# documented in cli/src/deploy/project-network.ts; this script moved all ten
# projects on dedicated-vps on 2026-10-19. Stops at the first check that
# fails and prints how to put things back.
#
#   move-project-network.sh <network> <app ids, comma-separated> [<db specs>]
#   db spec: <mongodb|postgresql|redis>:<coolify id>:<container>, comma-separated
#   DRY_RUN=1 prints the plan and changes nothing.
#
# Example (ids and containers from Coolify's database):
#   move-project-network.sh hk-asteroid-game 50 \
#     postgresql:2:azwms508qimcl8h4mzhcdtff,redis:4:r77nqy0ui83zzblcxr5usj42
set -uo pipefail
NET=$1
APPS=${2:-}
DBS=${3:-}
log() { echo "$(date -u +%T) $*"; }
fail() {
  log "FAIL: $*"
  log "rollback: set destination_id back to 0 for the items above that moved, then redeploy/restart them"
  exit 1
}
sql() { docker exec coolify-db psql -U coolify -d coolify -tA -c "$1"; }
tinker() { docker exec -u www-data coolify php artisan tinker --execute="$1" 2>&1; }
nets_of() { docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$1" 2>/dev/null | xargs; }
model_of() {
  case $1 in
    mongodb) echo StandaloneMongodb ;;
    postgresql) echo StandalonePostgresql ;;
    redis) echo StandaloneRedis ;;
    *) fail "unknown database type $1" ;;
  esac
}
table_of() {
  case $1 in
    mongodb) echo standalone_mongodbs ;;
    postgresql) echo standalone_postgresqls ;;
    redis) echo standalone_redis ;;
  esac
}

[[ $NET =~ ^hk-[a-z0-9][a-z0-9._-]*$ ]] || fail "network name $NET"

# --- plan --------------------------------------------------------------
log "plan for $NET"
for id in ${APPS//,/ }; do
  row=$(sql "select uuid, name, build_pack, destination_id from applications where id=$id and deleted_at is null")
  [ -n "$row" ] || fail "no application $id"
  log "  app $id: $row"
done
for spec in ${DBS//,/ }; do
  IFS=: read -r type id container <<<"$spec"
  row=$(sql "select uuid, name, destination_id from $(table_of "$type") where id=$id and deleted_at is null")
  [ -n "$row" ] || fail "no $type $id"
  [ "${row%%|*}" = "$container" ] || fail "$type $id is ${row%%|*}, not $container"
  log "  $type $id: $row on [$(nets_of "$container")]"
done
[ -n "${DRY_RUN:-}" ] && { log "dry run: nothing changed"; exit 0; }

# --- 1. destination ----------------------------------------------------
DEST=$(sql "select id from standalone_dockers where network='$NET' and server_id=0")
if [ -z "$DEST" ]; then
  tinker "App\\Models\\StandaloneDocker::create(['name' => '$NET', 'network' => '$NET', 'server_id' => 0]);" >/dev/null
  DEST=$(sql "select id from standalone_dockers where network='$NET' and server_id=0")
fi
[ -n "$DEST" ] || fail "destination $NET was not created"
docker network inspect "$NET" -f '{{range .Containers}}{{.Name}} {{end}}' | grep -qw coolify-proxy \
  || fail "coolify-proxy is not on $NET"
log "1. destination $NET id=$DEST (proxy attached)"

# --- 2. databases on both networks, live -------------------------------
for spec in ${DBS//,/ }; do
  IFS=: read -r type id container <<<"$spec"
  case " $(nets_of "$container") " in
    *" $NET "*) ;;
    *) docker network connect "$NET" "$container" || fail "connect $container to $NET" ;;
  esac
  log "2. $container on [$(nets_of "$container")]"
done

# --- 3. apps: new destination + rolling deploy --------------------------
for id in ${APPS//,/ }; do
  uuid=$(sql "select uuid from applications where id=$id")
  out=$(tinker "\$a = App\\Models\\Application::find($id); \$a->destination_id = $DEST; \$a->save(); \$u = (string) new Visus\\Cuid2\\Cuid2(); queue_application_deployment(application: \$a, deployment_uuid: \$u, force_rebuild: false); echo 'DEPLOY=' . \$u;")
  dep=$(grep -o 'DEPLOY=[a-z0-9]*' <<<"$out" | cut -d= -f2)
  [ -n "$dep" ] || fail "queue deploy of app $id: $out"
  status=""
  for _ in $(seq 1 90); do
    status=$(sql "select status from application_deployment_queues where deployment_uuid='$dep'")
    case $status in finished | failed | cancelled*) break ;; esac
    sleep 5
  done
  [ "$status" = finished ] || fail "deploy $dep of app $id: ${status:-no status}"
  sleep 3
  running=$(docker ps --format '{{.Names}}' | grep "^$uuid" || true)
  [ -n "$running" ] || fail "app $id has no running container after deploy"
  for c in $running; do
    [ "$(nets_of "$c")" = "$NET" ] || fail "app $id container $c is on [$(nets_of "$c")]"
  done
  log "3. app $id deployed ($dep): $(echo $running) on $NET"
done

# --- 4. databases: new destination + restart ----------------------------
for spec in ${DBS//,/ }; do
  IFS=: read -r type id container <<<"$spec"
  model=$(model_of "$type")
  before=$(docker inspect -f '{{.State.StartedAt}}' "$container")
  out=$(tinker "\$d = App\\Models\\$model::find($id); \$d->destination_id = $DEST; \$d->save(); App\\Actions\\Database\\RestartDatabase::run(\$d); echo 'RESTARTED';")
  grep -q RESTARTED <<<"$out" || fail "restart $type $id: $out"
  ok=""
  for _ in $(seq 1 60); do
    s=$(docker inspect -f '{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)
    if [ -n "$s" ] && [ "${s%%|*}" != "$before" ] && [ "${s##*|}" = healthy ] && [ "$(nets_of "$container")" = "$NET" ]; then
      ok=1
      break
    fi
    sleep 2
  done
  [ -n "$ok" ] || fail "$container not healthy on $NET only after restart (state: ${s:-gone}, nets: [$(nets_of "$container")])"
  log "4. $container restarted, healthy, on $NET only"
done

log "done: $NET holds [$(docker network inspect "$NET" -f '{{range .Containers}}{{.Name}} {{end}}' | xargs)]"
