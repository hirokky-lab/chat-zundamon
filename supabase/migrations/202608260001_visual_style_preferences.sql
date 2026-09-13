-- Additive owner-scoped preference. No existing profile, memory, or chat row is changed.
create table public.visual_style_preferences (
  user_id uuid primary key references auth.users(id),
  style text not null check (style in ('yui', 'minimal')),
  revision bigint not null check (revision >= 0 and revision <= 9007199254740991),
  updated_at timestamptz not null default now()
);

alter table public.visual_style_preferences enable row level security;
revoke all on table public.visual_style_preferences from public, anon, authenticated;

create function public.get_visual_style_preference()
returns table(style text, revision bigint, updated_at timestamptz)
language sql
security definer
set search_path = ''
stable
as $$
  select preference.style, preference.revision, preference.updated_at
  from public.visual_style_preferences preference
  where preference.user_id = (select auth.uid());
$$;

create function public.save_visual_style_preference(p_style text, p_expected_revision bigint)
returns table(style text, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare owner_id uuid := (select auth.uid());
current_preference public.visual_style_preferences%rowtype;
begin
  if owner_id is null or p_style is null or p_style not in ('yui', 'minimal')
    or p_expected_revision is null or p_expected_revision < 0 or p_expected_revision > 9007199254740991 then
    raise exception 'invalid visual style preference';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text || ':visual-style', 0));
  select preference.* into current_preference
  from public.visual_style_preferences preference
  where preference.user_id = owner_id;
  if found then
    if current_preference.revision <> p_expected_revision then
      return query select current_preference.style, current_preference.revision, current_preference.updated_at;
      return;
    end if;
    if current_preference.revision >= 9007199254740991 then
      raise exception 'visual style preference revision limit';
    end if;
    update public.visual_style_preferences preference set
      style = p_style,
      revision = preference.revision + 1,
      updated_at = pg_catalog.now()
    where preference.user_id = owner_id;
  else
    if p_expected_revision <> 0 then
      raise exception 'visual style preference revision conflict';
    end if;
    insert into public.visual_style_preferences (user_id, style, revision, updated_at)
    values (owner_id, p_style, 1, pg_catalog.now());
  end if;
  return query
    select preference.style, preference.revision, preference.updated_at
    from public.visual_style_preferences preference
    where preference.user_id = owner_id;
end;
$$;

revoke all on function public.get_visual_style_preference() from public, anon;
revoke all on function public.save_visual_style_preference(text, bigint) from public, anon;
grant execute on function public.get_visual_style_preference() to authenticated;
grant execute on function public.save_visual_style_preference(text, bigint) to authenticated;
