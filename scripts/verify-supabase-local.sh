#!/bin/sh
# Disposable, DB-only verification. Never uses linked/cloud Supabase state.
set -eu
case "${DOCKER_HOST:-}" in
  unix://*) ;;
  *) echo 'Set DOCKER_HOST to a local Docker unix socket before running.' >&2; exit 2 ;;
esac
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
node --input-type=module -e '
import { statfsSync } from "node:fs";
const disk = statfsSync(process.cwd());
if (disk.bavail * disk.bsize < 10 * 1024 ** 3) {
  console.error("DB verification needs at least 10 GiB of free host disk space. No database was started.");
  process.exit(2);
}
'
task_dir=$(mktemp -d /tmp/zundamon-db-verify.XXXXXX)
task_project="zundamon_verify_$$"
port_base=$((56000 + ($$ % 50) * 10))
cleanup() {
  pnpm exec supabase stop --workdir "$task_dir" --no-backup > "$task_dir/stop.log" 2>&1 || true
  # Keep the logs and SQL files for review; this directory never contains real data or remote links.
  echo "Verification logs: $task_dir"
}
trap cleanup EXIT INT TERM
mkdir -p "$task_dir/supabase/migrations" "$task_dir/supabase/tests"
sed \
  -e "s/project_id = \"zundamon-ai\"/project_id = \"$task_project\"/" \
  -e "s/55320/$((port_base))/g" \
  -e "s/55321/$((port_base + 1))/g" \
  -e "s/55322/$((port_base + 2))/g" \
  -e "s/55323/$((port_base + 3))/g" \
  -e "s/55324/$((port_base + 4))/g" \
  -e "s/55327/$((port_base + 7))/g" \
  -e "s/55329/$((port_base + 9))/g" \
  -e "s/inspector_port = 8183/inspector_port = $((port_base + 8))/" \
  -e "/^\[experimental.pgdelta\]/,\$s/enabled = true/enabled = false/" \
  supabase/config.toml > "$task_dir/supabase/config.toml"
cp supabase/migrations/*.sql "$task_dir/supabase/migrations/"
cp supabase/tests/*.test.sql "$task_dir/supabase/tests/"
echo "Starting isolated database: $task_project"
if ! node scripts/start-verification-db.mjs "$task_dir" > "$task_dir/start.log" 2>&1; then
  echo "Database startup failed. Inspect $task_dir/start.log" >&2
  exit 1
fi
node scripts/verify-supabase-sql.mjs "supabase_db_$task_project" "$task_dir/sql-output.log" > "$task_dir/tests.log" 2>&1 || {
  cat "$task_dir/tests.log"
  exit 1
}
cat "$task_dir/tests.log"
