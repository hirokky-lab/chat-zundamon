begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
insert into auth.users (id, aud, role, email, encrypted_password) values
 ('00000000-0000-0000-0000-00000000000a','authenticated','authenticated','a@zundamon.invalid',''),
 ('00000000-0000-0000-0000-00000000000b','authenticated','authenticated','b@zundamon.invalid','');
insert into public.profiles (user_id,display_name,addressing_style,occupation,region) values
 ('00000000-0000-0000-0000-00000000000a','A','san','企画','東京'),
 ('00000000-0000-0000-0000-00000000000b','B','san','研究','大阪');
select is((select public from storage.buckets where id='zundamon-backups'),false,'backup bucket is private');
-- A permissive policy must not bypass the backup restriction.
create policy test_broad_object_read on storage.objects for select to authenticated using (true);
insert into storage.objects (bucket_id,name) values ('zundamon-backups','backups/daily/2026-09-07.json');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',true);
select results_eq($$select occupation,region from public.profiles$$,$$values ('企画'::text,'東京'::text)$$,'only owner personal details are readable');
update public.profiles set occupation='',region='' where user_id='00000000-0000-0000-0000-00000000000a';
select results_eq($$select occupation,region from public.profiles$$,$$values (''::text,''::text)$$,'owner can clear both fields');
update public.profiles set region='changed' where user_id='00000000-0000-0000-0000-00000000000b';
select is((select count(*) from storage.objects where bucket_id='zundamon-backups'),0::bigint,'browser cannot read backup even with broad policy');
select throws_ok($$insert into public.profiles (user_id,display_name,addressing_style,occupation) values ('00000000-0000-0000-0000-00000000000a','A','san',repeat('x',121)) on conflict(user_id) do update set occupation=excluded.occupation$$,'23514',null,'oversized occupation rejected');
reset role;
select is((select region from public.profiles where user_id='00000000-0000-0000-0000-00000000000b'),'大阪','other owner was not modified');
set local role service_role;
select is((select count(*) from storage.objects where bucket_id='zundamon-backups'),1::bigint,'server can read backup');
select * from finish();
rollback;
