begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, aud, role, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000000e1', 'authenticated', 'authenticated', 'external-cost@yui.invalid', '');

select ok(
  not has_function_privilege('anon', 'public.reserve_yui_cost(uuid,text,text,numeric,numeric,numeric,numeric)', 'execute'),
  'anonymous callers cannot reserve external cost'
);
select ok(
  not has_function_privilege('authenticated', 'public.reserve_yui_cost(uuid,text,text,numeric,numeric,numeric,numeric)', 'execute'),
  'browser callers cannot reserve external cost'
);
select ok(
  has_function_privilege('service_role', 'public.reserve_yui_cost(uuid,text,text,numeric,numeric,numeric,numeric)', 'execute'),
  'only the server role can reserve external cost'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-search-1', 'search', 0.01, 0.10, 3, 10)).feature,
  'search'::text,
  'search has an independent cost category'
);
select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-calendar-1', 'calendar', 0.01, 0.10, 3, 10)).feature,
  'calendar'::text,
  'calendar has an independent cost category'
);
select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-notification-1', 'notification', 0.01, 0.10, 3, 10)).feature,
  'notification'::text,
  'notification has an independent cost category'
);
select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-image-1', 'image', 0.01, 0.10, 3, 10)).feature,
  'image'::text,
  'image has an independent cost category'
);
select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-work-1', 'work', 0.01, 0.10, 3, 10)).feature,
  'work'::text,
  'work has an independent cost category'
);
select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-avatar-1', 'avatar', 0.01, 0.10, 3, 10)).feature,
  'avatar'::text,
  'avatar has an independent cost category'
);
select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-storage-1', 'storage', 0.01, 0.10, 3, 10)).feature,
  'storage'::text,
  'save communication has an independent cost category'
);
select is(
  (public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-search-1', 'search', 0.01, 0.10, 3, 10)).request_id,
  'external-search-1'::text,
  'a duplicate request reuses its reservation'
);
reset role;
select is(
  (select count(*) from public.usage_reservations where user_id = '00000000-0000-0000-0000-0000000000e1' and request_id = 'external-search-1'),
  1::bigint,
  'duplicate reservation creates one cost row'
);
set local role service_role;
select throws_ok(
  $$ select public.reserve_yui_cost('00000000-0000-0000-0000-0000000000e1', 'external-invalid-1', 'external-body', 0.01, 0.10, 3, 10) $$,
  'P0001', 'invalid cost feature',
  'unclassified external cost is rejected'
);

select * from finish();
rollback;
