begin;
select plan(12);
insert into auth.users(id,aud,role,email,encrypted_password) values
 ('00000000-0000-4000-8000-0000000000c1','authenticated','authenticated','personal-c@yui.invalid',''),
 ('00000000-0000-4000-8000-0000000000d1','authenticated','authenticated','personal-d@yui.invalid','');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c1',true);
select is(public.update_life_settings(0,'{"revision":0,"home":null,"calendar":null,"tasks":null,"personal":{"nickname":"ニック","occupation":"企画","details":"料理\n犬","responsePreferences":"簡潔に"}}')->>'revision','1','personal save increments revision');
select is(public.update_life_settings(1,'{"revision":1,"home":null,"calendar":null,"tasks":null}')->'personal'->>'nickname','ニック','legacy update preserves personal');
select is(public.update_life_settings(1,'{"revision":1,"home":null,"calendar":null,"tasks":null}'),null::jsonb,'stale revision conflicts');
select throws_ok($$select public.update_life_settings(2,'{"revision":2,"home":null,"calendar":null,"tasks":null,"personal":null}')$$,'P0001','Invalid settings','null rejected');
select throws_ok($$select public.update_life_settings(2,'{"revision":2,"home":null,"calendar":null,"tasks":null,"personal":{"nickname":"x","occupation":"","details":"","responsePreferences":"","extra":"x"}}')$$,'P0001','Invalid settings','unknown fields rejected');
select throws_ok($$select public.update_life_settings(2,'{"revision":2,"home":null,"calendar":null,"tasks":null,"personal":{"nickname":"123456789012345678901","occupation":"","details":"","responsePreferences":""}}')$$,'P0001','Invalid settings','overlong nickname rejected');
select throws_ok($$select public.update_life_settings(2,'{"revision":2,"home":null,"calendar":null,"tasks":null,"personal":{"nickname":"a\nb","occupation":"","details":"","responsePreferences":""}}')$$,'P0001','Invalid settings','single line enforced');
select throws_ok($$select public.update_life_settings(2,'{"revision":2,"home":null,"calendar":null,"tasks":null,"personal":{"nickname":"","occupation":"","details":"a\tb","responsePreferences":""}}')$$,'P0001','Invalid settings','control characters rejected');
select is(public.get_life_settings()->>'revision','2','invalid writes preserve revision');
select is(public.update_life_settings(2,'{"revision":2,"home":null,"calendar":null,"tasks":null,"personal":{"nickname":"","occupation":"","details":"","responsePreferences":""}}')->'personal'->>'nickname','','explicit empty fields clear');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d1',true);
select ok(not(public.get_life_settings() ? 'personal'),'other owner cannot read personal');
select is(public.update_life_settings(0,'{"revision":0,"home":null,"calendar":null,"tasks":null}')->>'revision','1','other owner revisions independent');
select * from finish();
rollback;
