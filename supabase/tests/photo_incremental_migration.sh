#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_dir"

tmp_dir=$(mktemp -d /tmp/zundamon-photo-incremental.XXXXXX)
project_id="zundamon_photo_incremental_$$"
port_base=$((57000 + ($$ % 50) * 10))
cleanup() {
  pnpm exec supabase stop --workdir "$tmp_dir" --no-backup >/dev/null 2>&1 || true
  case "$tmp_dir" in
    /tmp/zundamon-photo-incremental.*) rm -rf -- "$tmp_dir" ;;
  esac
}
trap cleanup EXIT INT TERM

mkdir -p "$tmp_dir/supabase/migrations"
sed \
  -e "s/project_id = \"zundamon-ai\"/project_id = \"$project_id\"/" \
  -e "s/port = 55321/port = $((port_base + 1))/" \
  -e "s/port = 55322/port = $((port_base + 2))/" \
  -e "s/shadow_port = 55320/shadow_port = $((port_base + 0))/" \
  -e "s/port = 55329/port = $((port_base + 9))/" \
  -e "s/port = 55323/port = $((port_base + 3))/" \
  -e "s/port = 55324/port = $((port_base + 4))/" \
  -e "s/port = 55327/port = $((port_base + 7))/" \
  -e "s/inspector_port = 8183/inspector_port = $((port_base + 8))/" \
  supabase/config.toml > "$tmp_dir/supabase/config.toml"
cp supabase/migrations/*.sql "$tmp_dir/supabase/migrations/"

db_container="supabase_db_$project_id"
prepare_sql="supabase/tests/photo_incremental_migration_prepare.sql"
verify_sql="supabase/tests/photo_incremental_migration_verify.sql"

pnpm exec supabase start --workdir "$tmp_dir" --exclude gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
pnpm exec supabase db reset --local --no-seed --version 202608140001 --workdir "$tmp_dir"
docker exec -i "$db_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$prepare_sql"
pnpm exec supabase migration up --local --workdir "$tmp_dir"
docker exec -i "$db_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$verify_sql"

echo "photo incremental migration: PASS"

pnpm exec supabase db reset --local --no-seed --workdir "$tmp_dir"
pnpm exec supabase db lint --local --level warning --workdir "$tmp_dir"

echo "photo fresh migration and lint: PASS"
