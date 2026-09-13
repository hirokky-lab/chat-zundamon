import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const container = process.argv[2];
if (!process.env.DOCKER_HOST?.startsWith('unix://') || !/^supabase_db_zundamon_verify_\d+$/.test(container ?? '')) {
  throw new Error('Only the disposable local zundamon verification database is allowed');
}
const sql = input => spawnSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', container, 'psql', '-h', container, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], {input, encoding:'utf8', maxBuffer:10*1024*1024});
const setup=sql('create extension if not exists pgtap with schema extensions;');
if (setup.status !== 0) throw new Error(setup.stderr);
let failures=0, total=0;
const files=readdirSync('supabase/tests').filter(name=>name.endsWith('.test.sql')).sort();
if (!files.length) throw new Error('No SQL tests found');
const logs=[];
for (const file of files) {
  const result=sql(readFileSync(`supabase/tests/${file}`, 'utf8'));
  const output=result.stdout ?? '';
  const plan=output.match(/^1\.\.(\d+)$/m);
  const passed=[...output.matchAll(/^ok \d+(?:\s|$)/gm)].length;
  const failed=result.status !== 0 || !plan || passed !== Number(plan[1]) || /^not ok /m.test(output);
  total += passed;
  if (failed) failures++;
  console.log(`${failed?'FAIL':'PASS'} ${file} (${passed}/${plan?.[1]??'no plan'})`);
  logs.push(`FILE ${file}\n${output}\n${result.stderr??''}`);
}
if (process.argv[3]) writeFileSync(process.argv[3], logs.join('\n'));
console.log(`Passed assertions: ${total}; failed files: ${failures}`);
process.exitCode=failures?1:0;
