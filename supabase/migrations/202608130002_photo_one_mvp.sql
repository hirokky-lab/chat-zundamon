alter table public.chat_snapshots
  drop constraint if exists chat_snapshots_version_check;
alter table public.chat_snapshots
  add constraint chat_snapshots_version_check check (version in (1, 2, 3));

revoke insert, update, delete on table public.chat_snapshots from authenticated;
grant select, insert, update, delete on table public.chat_snapshots to service_role;

create table if not exists public.photo_requests (
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_message_id uuid not null check (client_message_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  photo_id uuid not null default gen_random_uuid() check (photo_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  caption text,
  caption_digest text check (caption_digest is null or caption_digest ~ '^[0-9a-f]{64}$'),
  jpeg_digest text check (jpeg_digest is null or jpeg_digest ~ '^[0-9a-f]{64}$'),
  request_state text not null default 'claimed'
    check (request_state in ('claimed','uploading','uploaded','analyzing','succeeded','failed','ambiguous','blocked')),
  analysis_state text not null default 'not_dispatched'
    check (analysis_state in ('not_dispatched','dispatched','succeeded','failed','ambiguous','scrubbed')),
  deletion_state text
    check (deletion_state is null or deletion_state in ('requested','blocked_from_use','deleting','deleted','verified')),
  lease_owner text,
  lease_expires_at timestamptz,
  receipt jsonb,
  usage jsonb,
  dispatched_at timestamptz,
  completed_at timestamptz,
  blocked_at timestamptz,
  deleted_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, client_message_id),
  unique (owner_id, photo_id)
);

create table if not exists public.photo_assets (
  id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  root_data_id uuid not null,
  parent_data_ids uuid[] not null default '{}',
  purpose text not null check (purpose = 'conversation'),
  storage_bucket text not null check (storage_bucket = 'yui-photo'),
  storage_path text not null,
  content_type text not null check (content_type = 'image/jpeg'),
  byte_size bigint not null check (byte_size between 1 and 5242880),
  state text not null check (state in ('active','blocked','deleted','verified')),
  attached_message_id uuid,
  created_at timestamptz not null default now(),
  blocked_at timestamptz,
  deleted_at timestamptz,
  verified_at timestamptz,
  primary key (owner_id, id),
  unique (owner_id, storage_path)
);
create unique index if not exists photo_assets_attached_message_unique
  on public.photo_assets(owner_id, attached_message_id)
  where attached_message_id is not null;

create table if not exists public.photo_deletion_outbox (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  photo_id uuid not null,
  storage_path text not null,
  reason text not null check (reason in ('photo_deleted','chat_deleted','account_deleted','orphaned','ambiguous')),
  state text not null default 'requested' check (state in ('requested','deleting','deleted','verified')),
  lease_owner text,
  lease_expires_at timestamptz,
  requested_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  deleted_at timestamptz,
  verified_at timestamptz
);
create unique index if not exists photo_deletion_outbox_live_unique
  on public.photo_deletion_outbox(owner_id, photo_id)
  where state <> 'verified';

create table if not exists public.photo_storage_scan_cursors (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  cursor text,
  updated_at timestamptz not null default now()
);

alter table public.photo_requests enable row level security;
alter table public.photo_assets enable row level security;
alter table public.photo_deletion_outbox enable row level security;
alter table public.photo_storage_scan_cursors enable row level security;

revoke all on table public.photo_requests from public, anon, authenticated;
revoke all on table public.photo_assets from public, anon, authenticated;
revoke all on table public.photo_deletion_outbox from public, anon, authenticated;
revoke all on table public.photo_storage_scan_cursors from public, anon, authenticated;
grant select, insert, update, delete on table public.photo_requests to service_role;
grant select, insert, update, delete on table public.photo_assets to service_role;
grant select, insert, update, delete on table public.photo_deletion_outbox to service_role;
grant select, insert, update, delete on table public.photo_storage_scan_cursors to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('yui-photo', 'yui-photo', false, 5242880, array['image/jpeg']::text[])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.assert_photo_service_owner(p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' or p_owner_id is null then
    raise exception 'photo server operation required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.is_photo_uuid_v4(p_value text)
returns boolean language sql immutable security definer set search_path=''
as $$ select p_value is not null and p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' $$;

create or replace function public.is_photo_digest(p_value text)
returns boolean language sql immutable security definer set search_path=''
as $$ select p_value is not null and p_value ~ '^[0-9a-f]{64}$' $$;

create or replace function public.is_photo_canonical_timestamp(p_value text)
returns boolean language plpgsql stable security definer set search_path=''
as $$
declare parsed timestamptz;
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then return false; end if;
  parsed := p_value::timestamptz;
  return to_char(parsed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=p_value;
exception when others then return false;
end;
$$;

create or replace function public.is_photo_canonical_https_url(p_value text)
returns boolean language plpgsql immutable security definer set search_path=''
as $$
declare authority text; host_port text; host text; port text; part text;
begin
  if p_value is null or p_value !~ '^https://[^/?#]+/' or p_value ~ '[[:space:][:cntrl:]]' then return false; end if;
  authority:=substring(p_value from '^https://([^/?#]+)');
  if authority is null or authority='' or position('@' in authority)>0 then return false; end if;
  host_port:=authority;
  if host_port ~ '^\[' then
    if host_port !~ '^\[[0-9a-f:.]+\](:[0-9]+)?$' then return false; end if;
    host:=substring(host_port from '^(\[[0-9a-f:.]+\])');
    port:=substring(host_port from '\]:([0-9]+)$');
  else
    if host_port !~ '^[a-z0-9.-]+(:[0-9]+)?$' then return false; end if;
    host:=split_part(host_port,':',1);
    port:=nullif(substring(host_port from ':([0-9]+)$'),'');
    if host='' or host like '.%' or host like '%.' or host like '%..%'
      or exists(select 1 from unnest(string_to_array(host,'.')) label where label='' or label like '-%' or label like '%-' or length(label)>63) then
      return false;
    end if;
    if host ~* '^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$' then
      if host !~ '^((0|[1-9][0-9]{0,2})\.){3}(0|[1-9][0-9]{0,2})$' then return false; end if;
      foreach part in array string_to_array(host,'.') loop
        if part::integer>255 then return false; end if;
      end loop;
    end if;
  end if;
  if port='443' or (port is not null and (port::integer<1 or port::integer>65535)) then return false; end if;
  if p_value ~ '/(\.|%2[eE])(/|$)' or p_value ~ '/(\.\.|%2[eE]%2[eE])(/|$)' then return false; end if;
  return true;
exception when others then return false;
end;
$$;

create or replace function public.is_photo_canonical_local_date(p_value text)
returns boolean language plpgsql stable security definer set search_path=''
as $$
declare parsed date;
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  parsed:=p_value::date;
  return to_char(parsed,'YYYY-MM-DD')=p_value;
exception when others then return false;
end;
$$;

create or replace function public.assert_photo_receipt(p_client_message_id uuid,p_receipt jsonb)
returns void language plpgsql stable security definer set search_path=''
as $$
declare bubble jsonb; bubble_keys text[]; group_id text;
begin
  if not public.is_photo_uuid_v4(p_client_message_id::text) or jsonb_typeof(p_receipt)<>'object'
    or (select array_agg(key order by key) from jsonb_object_keys(p_receipt) key)<>array['bubbles','photo','replyGroupId']
    or jsonb_typeof(p_receipt->'photo')<>'object'
    or (select array_agg(key order by key) from jsonb_object_keys(p_receipt->'photo') key)<>array['createdAt','delivery','id']
    or p_receipt->'photo'->>'id'<>p_client_message_id::text
    or not public.is_photo_canonical_timestamp(p_receipt->'photo'->>'createdAt')
    or p_receipt->'photo'->>'delivery'<>'sent'
    or jsonb_typeof(p_receipt->'replyGroupId')<>'string' or coalesce(length(p_receipt->>'replyGroupId'),0)=0
    or jsonb_typeof(p_receipt->'bubbles')<>'array' or jsonb_array_length(p_receipt->'bubbles') not between 1 and 3 then
    raise exception 'invalid photo receipt' using errcode='22023';
  end if;
  group_id:=p_receipt->>'replyGroupId';
  for idx in 0..jsonb_array_length(p_receipt->'bubbles')-1 loop
    bubble:=p_receipt->'bubbles'->idx;
    if jsonb_typeof(bubble)<>'object' then raise exception 'invalid photo receipt' using errcode='22023'; end if;
    select array_agg(key order by key) into bubble_keys from jsonb_object_keys(bubble) key;
    if bubble_keys<>array['createdAt','delivery','id','origin','sequence','sourcePhotoMessageId','text']
      or bubble->>'id'<>group_id||':'||idx::text
      or jsonb_typeof(bubble->'sequence')<>'number'
      or (bubble->>'sequence')::numeric<>trunc((bubble->>'sequence')::numeric)
      or (bubble->>'sequence')::integer<>idx
      or jsonb_typeof(bubble->'text')<>'string' or coalesce(length(bubble->>'text'),0)=0 or length(bubble->>'text')>400 or bubble->>'text' ~ '[[:cntrl:]]'
      or not public.is_photo_canonical_timestamp(bubble->>'createdAt')
      or bubble->>'delivery'<>'sent' or bubble->>'origin'<>'photo_analysis'
      or bubble->>'sourcePhotoMessageId'<>p_client_message_id::text then
      raise exception 'invalid photo receipt' using errcode='22023';
    end if;
  end loop;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid photo receipt' using errcode='22023';
end;
$$;

create or replace function public.assert_photo_snapshot(p_snapshot jsonb)
returns void
language plpgsql
  stable
security definer
set search_path = ''
as $$
declare
  item jsonb;
  keys text[];
  item_keys text[];
  snapshot_version integer;
  snapshot_revision bigint;
  has_reply boolean;
  has_origin boolean;
  source jsonb;
  source_urls text[];
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
    or jsonb_typeof(p_snapshot->'timeline') <> 'array'
    or jsonb_array_length(p_snapshot->'timeline') > 20000
    or jsonb_typeof(p_snapshot->'version') <> 'number'
    or jsonb_typeof(p_snapshot->'revision') <> 'number' then
    raise exception 'invalid chat snapshot' using errcode = '22023';
  end if;
  snapshot_version := (p_snapshot->>'version')::integer;
  snapshot_revision := (p_snapshot->>'revision')::bigint;
  if (p_snapshot->>'version')::numeric <> trunc((p_snapshot->>'version')::numeric)
    or (p_snapshot->>'revision')::numeric <> trunc((p_snapshot->>'revision')::numeric)
    or snapshot_version not in (1,2,3) or snapshot_revision < 0 or snapshot_revision > 9007199254740991
    or not public.is_photo_canonical_timestamp(p_snapshot->>'updatedAt')
    or (p_snapshot->'lastOpeningAt' <> 'null'::jsonb and not public.is_photo_canonical_timestamp(p_snapshot->>'lastOpeningAt'))
    or (p_snapshot->'lastConversationAt' <> 'null'::jsonb and not public.is_photo_canonical_timestamp(p_snapshot->>'lastConversationAt')) then
    raise exception 'invalid chat snapshot' using errcode = '22023';
  end if;
  select array_agg(key order by key) into keys from jsonb_object_keys(p_snapshot) key;
  if snapshot_version = 1 then
    if keys <> array['lastConversationAt','lastOpeningAt','reviewedLocalDates','revision','timeline','updatedAt','version'] then
      raise exception 'invalid chat snapshot' using errcode = '22023';
    end if;
    if jsonb_typeof(p_snapshot->'reviewedLocalDates') <> 'array'
      or exists(select 1 from jsonb_array_elements_text(p_snapshot->'reviewedLocalDates') d where not public.is_photo_canonical_local_date(d)) then
      raise exception 'invalid legacy review dates' using errcode='22023';
    end if;
  elsif keys <> array['lastConversationAt','lastOpeningAt','revision','timeline','updatedAt','version'] then
    raise exception 'invalid chat snapshot' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p_snapshot->'timeline') loop
    if jsonb_typeof(item) <> 'object' or coalesce(length(item->>'id'),0)=0 or item->>'type' is null then
      raise exception 'invalid chat snapshot item' using errcode = '22023';
    end if;
    select array_agg(key order by key) into item_keys from jsonb_object_keys(item) key;
    if item->>'type' = 'photo' then
      if snapshot_version <> 3
        or item_keys <> array['caption','createdAt','delivery','id','origin','photoId','role','type']
        or item->>'role' <> 'user' or item->>'origin' <> 'photo'
        or not public.is_photo_uuid_v4(item->>'id') or not public.is_photo_uuid_v4(item->>'photoId')
        or jsonb_typeof(item->'caption') <> 'string' or length(item->>'caption') > 400 or item->>'caption' ~ '[[:cntrl:]]'
        or not public.is_photo_canonical_timestamp(item->>'createdAt')
        or item->>'delivery' not in ('sending','sent','failed') then
        raise exception 'invalid photo snapshot item' using errcode = '22023';
      end if;
    elsif item->>'type' = 'call' then
      if item_keys <> array['endedAt','id','startedAt','type']
        or not public.is_photo_canonical_timestamp(item->>'startedAt')
        or not public.is_photo_canonical_timestamp(item->>'endedAt') then
        raise exception 'invalid call snapshot item' using errcode='22023';
      end if;
    elsif item->>'type' = 'message' then
      if item->>'role' not in ('user','assistant')
        or jsonb_typeof(item->'text') <> 'string'
        or not public.is_photo_canonical_timestamp(item->>'createdAt')
        or item->>'delivery' not in ('sending','sent','failed')
        or (item ? 'flow' and item->>'flow' not in ('conversation','profile')) then
        raise exception 'invalid message snapshot item' using errcode='22023';
      end if;
      has_reply := item ? 'replyGroupId' or item ? 'sequence';
      has_origin := item ? 'origin' or item ? 'sourcePhotoMessageId';
      if item->>'role'='user' then
        if not (item_keys <@ array['createdAt','delivery','flow','id','role','text','type'])
          or item ? 'replyGroupId' or item ? 'sequence' or item ? 'search' or has_origin then
          raise exception 'invalid user snapshot item' using errcode='22023';
        end if;
      else
        if not (item_keys <@ array['createdAt','delivery','flow','id','origin','replyGroupId','role','search','sequence','sourcePhotoMessageId','text','type']) then
          raise exception 'invalid assistant snapshot keys' using errcode='22023';
        end if;
        if has_reply and (not (item ? 'replyGroupId' and item ? 'sequence')
          or coalesce(length(item->>'replyGroupId'),0)=0
          or jsonb_typeof(item->'sequence')<>'number'
          or (item->>'sequence')::numeric<>trunc((item->>'sequence')::numeric)
          or (item->>'sequence')::integer not between 0 and 2
          or item->>'id' <> (item->>'replyGroupId') || ':' || (item->>'sequence')) then
          raise exception 'invalid assistant reply shape' using errcode='22023';
        end if;
        if item ? 'search' then
          if not has_reply or jsonb_typeof(item->'search')<>'object'
            or (select array_agg(key order by key) from jsonb_object_keys(item->'search') key) <> array['searchedAt','sources','status']
            or not public.is_photo_canonical_timestamp(item->'search'->>'searchedAt')
            or item->'search'->>'status' not in ('completed','failed')
            or jsonb_typeof(item->'search'->'sources')<>'array' then
            raise exception 'invalid search metadata' using errcode='22023';
          end if;
          if item->'search'->>'status'='failed' and jsonb_array_length(item->'search'->'sources')<>0 then
            raise exception 'invalid failed search metadata' using errcode='22023';
          end if;
          if item->'search'->>'status'='completed' and jsonb_array_length(item->'search'->'sources') not between 1 and 5 then
            raise exception 'invalid completed search metadata' using errcode='22023';
          end if;
          source_urls:=array[]::text[];
          for source in select value from jsonb_array_elements(item->'search'->'sources') loop
            if jsonb_typeof(source)<>'object'
              or (select array_agg(key order by key) from jsonb_object_keys(source) key) <> array['title','url']
              or coalesce(length(source->>'title'),0)=0 or length(source->>'title')>200 or source->>'title' ~ '[[:cntrl:]]'
              or not public.is_photo_canonical_https_url(source->>'url')
              or source->>'url'=any(source_urls) then
              raise exception 'invalid search source' using errcode='22023';
            end if;
            source_urls:=array_append(source_urls,source->>'url');
          end loop;
        end if;
        if has_origin and (snapshot_version<>3 or not (item ? 'origin' and item ? 'sourcePhotoMessageId')
          or item->>'origin'<>'photo_analysis' or not public.is_photo_uuid_v4(item->>'sourcePhotoMessageId') or not has_reply) then
          raise exception 'invalid photo analysis lineage' using errcode = '22023';
        end if;
      end if;
    else
      raise exception 'invalid chat snapshot item type' using errcode='22023';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_snapshot->'timeline')) <>
     (select count(distinct value->>'id') from jsonb_array_elements(p_snapshot->'timeline')) then
    raise exception 'duplicate timeline id' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(p_snapshot->'timeline') elem where elem->>'type'='photo') <>
     (select count(distinct elem->>'photoId') from jsonb_array_elements(p_snapshot->'timeline') elem where elem->>'type'='photo') then
    raise exception 'duplicate photo id' using errcode='22023';
  end if;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid chat snapshot' using errcode = '22023';
end;
$$;

create or replace function public.claim_photo_request(
  p_owner_id uuid,
  p_client_message_id uuid,
  p_caption_digest text,
  p_jpeg_digest text,
  p_lease_owner text
)
returns public.photo_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.photo_requests;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  if not public.is_photo_uuid_v4(p_client_message_id::text)
    or not public.is_photo_digest(p_caption_digest) or not public.is_photo_digest(p_jpeg_digest)
    or p_lease_owner is null or length(p_lease_owner) = 0 then
    raise exception 'invalid photo claim' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text || ':' || p_client_message_id::text, 0));
  select * into existing from public.photo_requests
    where owner_id=p_owner_id and client_message_id=p_client_message_id for update;
  if found then
    if existing.caption_digest is distinct from p_caption_digest or existing.jpeg_digest is distinct from p_jpeg_digest then
      raise exception 'photo digest mismatch' using errcode = '22023';
    end if;
    if existing.analysis_state = 'dispatched' and existing.lease_expires_at <= now() then
      update public.photo_requests set request_state='ambiguous', analysis_state='ambiguous', updated_at=now()
        where owner_id=p_owner_id and client_message_id=p_client_message_id returning * into existing;
    elsif existing.analysis_state='not_dispatched' and existing.request_state in ('claimed','uploading','uploaded')
      and (existing.lease_expires_at is null or existing.lease_expires_at <= now() or existing.lease_owner=p_lease_owner) then
      update public.photo_requests set lease_owner=p_lease_owner, lease_expires_at=now()+interval '120 seconds', updated_at=now()
        where owner_id=p_owner_id and client_message_id=p_client_message_id returning * into existing;
    end if;
    return existing;
  end if;
  insert into public.photo_requests(owner_id,client_message_id,caption_digest,jpeg_digest,lease_owner,lease_expires_at)
    values(p_owner_id,p_client_message_id,p_caption_digest,p_jpeg_digest,p_lease_owner,now()+interval '120 seconds')
    returning * into existing;
  return existing;
end;
$$;

create or replace function public.begin_photo_upload(p_owner_id uuid,p_client_message_id uuid,p_lease_owner text)
returns public.photo_requests
language plpgsql security definer set search_path=''
as $$
declare r public.photo_requests;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  update public.photo_requests set request_state='uploading',updated_at=now()
    where owner_id=p_owner_id and client_message_id=p_client_message_id
      and request_state in ('claimed','uploading') and analysis_state='not_dispatched'
      and lease_owner=p_lease_owner and lease_expires_at>now() returning * into r;
  if not found then raise exception 'photo upload lease mismatch' using errcode='42501'; end if;
  return r;
end;
$$;

create or replace function public.complete_photo_upload(
  p_owner_id uuid,
  p_client_message_id uuid,
  p_lease_owner text,
  p_storage_path text,
  p_byte_size bigint
)
returns public.photo_requests
language plpgsql security definer set search_path=''
as $$
declare r public.photo_requests; existing public.photo_assets; expected_path text;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  expected_path:=p_owner_id::text||'/'||(select photo_id::text from public.photo_requests
    where owner_id=p_owner_id and client_message_id=p_client_message_id)||'.jpg';
  if p_storage_path is null or p_storage_path is distinct from expected_path or p_byte_size not between 1 and 5242880 then
    raise exception 'invalid photo asset' using errcode='22023';
  end if;
  update public.photo_requests set request_state='uploaded',updated_at=now()
    where owner_id=p_owner_id and client_message_id=p_client_message_id
      and request_state in ('uploading','uploaded') and analysis_state='not_dispatched'
      and lease_owner=p_lease_owner and lease_expires_at>now() returning * into r;
  if not found then raise exception 'photo upload lease mismatch' using errcode='42501'; end if;
  select * into existing from public.photo_assets where owner_id=p_owner_id and id=r.photo_id for update;
  if found then
    if existing.root_data_id<>r.photo_id or existing.parent_data_ids<>array[]::uuid[]
      or existing.purpose<>'conversation' or existing.storage_bucket<>'yui-photo'
      or existing.storage_path<>p_storage_path or existing.content_type<>'image/jpeg'
      or existing.byte_size<>p_byte_size or existing.state<>'active' or existing.attached_message_id is not null then
      raise exception 'photo asset mismatch' using errcode='22023';
    end if;
  else
    insert into public.photo_assets(id,owner_id,root_data_id,parent_data_ids,purpose,storage_bucket,storage_path,content_type,byte_size,state)
      values(r.photo_id,p_owner_id,r.photo_id,array[]::uuid[],'conversation','yui-photo',p_storage_path,'image/jpeg',p_byte_size,'active');
  end if;
  return r;
end;
$$;

create or replace function public.claim_photo_analysis(p_owner_id uuid,p_client_message_id uuid,p_lease_owner text)
returns public.photo_requests
language plpgsql security definer set search_path=''
as $$
declare r public.photo_requests;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  select * into r from public.photo_requests where owner_id=p_owner_id and client_message_id=p_client_message_id for update;
  if not found then raise exception 'photo request not found' using errcode='P0002'; end if;
  if r.analysis_state='dispatched' then
    if r.lease_expires_at <= now() then
      update public.photo_requests set request_state='ambiguous',analysis_state='ambiguous',updated_at=now()
        where owner_id=p_owner_id and client_message_id=p_client_message_id returning * into r;
      return r;
    end if;
    raise exception 'photo analysis already dispatched' using errcode='55000';
  end if;
  if r.request_state <> 'uploaded' or r.analysis_state <> 'not_dispatched' then
    raise exception 'photo analysis is not claimable' using errcode='55000';
  end if;
  update public.photo_requests set request_state='analyzing',analysis_state='dispatched',lease_owner=p_lease_owner,
    lease_expires_at=now()+interval '120 seconds',dispatched_at=now(),updated_at=now()
    where owner_id=p_owner_id and client_message_id=p_client_message_id returning * into r;
  return r;
end;
$$;

create or replace function public.complete_photo_analysis(p_owner_id uuid,p_client_message_id uuid,p_lease_owner text,p_receipt jsonb,p_usage jsonb)
returns public.photo_requests
language plpgsql security definer set search_path=''
as $$
declare r public.photo_requests;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  perform public.assert_photo_receipt(p_client_message_id,p_receipt);
  if p_usage is null or jsonb_typeof(p_usage)<>'object' then raise exception 'invalid photo usage' using errcode='22023'; end if;
  update public.photo_requests set request_state='succeeded',analysis_state='succeeded',receipt=p_receipt,usage=p_usage,
    completed_at=now(),lease_owner=null,lease_expires_at=null,updated_at=now()
    where owner_id=p_owner_id and client_message_id=p_client_message_id and analysis_state='dispatched'
      and lease_owner=p_lease_owner returning * into r;
  if not found then raise exception 'photo analysis lease mismatch' using errcode='42501'; end if;
  return r;
end;
$$;

create or replace function public.fail_photo_request(p_owner_id uuid,p_client_message_id uuid,p_lease_owner text,p_ambiguous boolean default false)
returns public.photo_requests
language plpgsql security definer set search_path=''
as $$
declare r public.photo_requests;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  update public.photo_requests set request_state=case when p_ambiguous then 'ambiguous' else 'failed' end,
    analysis_state=case when p_ambiguous then 'ambiguous' else 'failed' end,
    lease_owner=null,lease_expires_at=null,updated_at=now()
    where owner_id=p_owner_id and client_message_id=p_client_message_id and lease_owner=p_lease_owner returning * into r;
  if not found then raise exception 'photo request lease mismatch' using errcode='42501'; end if;
  return r;
end;
$$;

create or replace function public.get_active_photo(p_owner_id uuid,p_photo_id uuid)
returns public.photo_assets language plpgsql security definer set search_path=''
as $$
declare asset public.photo_assets;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  select a.* into asset from public.photo_assets a
    join public.photo_requests r on r.owner_id=a.owner_id and r.photo_id=a.id
    where a.owner_id=p_owner_id and a.id=p_photo_id and a.state='active'
      and r.request_state='succeeded' and r.analysis_state='succeeded' and r.deletion_state is null;
  return asset;
end;
$$;

create or replace function public.photo_snapshot_refs(p_snapshot jsonb,p_kind text)
returns text[] language sql immutable security definer set search_path=''
as $$
  select coalesce(array_agg(ref order by ref),array[]::text[]) from (
    select case when p_kind='photo' then item->>'photoId' else item->>'sourcePhotoMessageId' end ref
    from jsonb_array_elements(p_snapshot->'timeline') item
    where (p_kind='photo' and item->>'type'='photo')
       or (p_kind='analysis' and item->>'origin'='photo_analysis')
  ) refs;
$$;

create or replace function public.save_chat_snapshot_reconciled(p_owner_id uuid,p_expected_revision bigint,p_snapshot jsonb)
returns public.chat_snapshots
language plpgsql security definer set search_path=''
as $$
declare old public.chat_snapshots; saved public.chat_snapshots;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  perform public.assert_photo_snapshot(p_snapshot);
  select * into old from public.chat_snapshots where user_id=p_owner_id for update;
  if not found or old.revision <> p_expected_revision or (p_snapshot->>'revision')::bigint <> p_expected_revision+1 then
    raise exception 'snapshot revision mismatch' using errcode='40001';
  end if;
  if public.photo_snapshot_refs(old.snapshot,'photo') <> public.photo_snapshot_refs(p_snapshot,'photo')
    or public.photo_snapshot_refs(old.snapshot,'analysis') <> public.photo_snapshot_refs(p_snapshot,'analysis') then
    raise exception 'photo lineage requires dedicated operation' using errcode='22023';
  end if;
  update public.chat_snapshots set version=(p_snapshot->>'version')::integer,revision=(p_snapshot->>'revision')::bigint,
    snapshot=p_snapshot,updated_at=(p_snapshot->>'updatedAt')::timestamptz where user_id=p_owner_id returning * into saved;
  return saved;
end;
$$;

create or replace function public.commit_photo_exchange(p_owner_id uuid,p_client_message_id uuid,p_expected_revision bigint,p_snapshot jsonb)
returns public.chat_snapshots
language plpgsql security definer set search_path=''
as $$
declare
  req public.photo_requests;
  saved public.chat_snapshots;
  old public.chat_snapshots;
  message_id uuid;
  old_timeline jsonb := '[]'::jsonb;
  new_timeline jsonb;
  old_count integer;
  bubble_count integer;
  delta_item jsonb;
  bubble jsonb;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  perform public.assert_photo_snapshot(p_snapshot);
  select * into req from public.photo_requests where owner_id=p_owner_id and client_message_id=p_client_message_id for update;
  if not found or req.request_state<>'succeeded' or req.analysis_state<>'succeeded' or req.receipt is null then
    raise exception 'photo receipt is not complete' using errcode='55000';
  end if;
  perform public.assert_photo_receipt(p_client_message_id,req.receipt);
  select * into old from public.chat_snapshots where user_id=p_owner_id for update;
  if found then old_timeline:=old.snapshot->'timeline'; end if;
  if coalesce(old.revision,0)<>p_expected_revision or (p_snapshot->>'revision')::bigint<>p_expected_revision+1 then
    raise exception 'snapshot revision mismatch' using errcode='40001';
  end if;
  new_timeline:=p_snapshot->'timeline';
  old_count:=jsonb_array_length(old_timeline);
  bubble_count:=jsonb_array_length(req.receipt->'bubbles');
  if jsonb_array_length(new_timeline)<>old_count+1+bubble_count then
    raise exception 'invalid photo commit delta' using errcode='22023';
  end if;
  if old_count>0 then
    for index in 0..old_count-1 loop
      if old_timeline->index is distinct from new_timeline->index then
        raise exception 'existing timeline changed during photo commit' using errcode='22023';
      end if;
    end loop;
  end if;
  delta_item:=new_timeline->old_count;
  if delta_item->>'type'<>'photo' or delta_item->>'photoId'<>req.photo_id::text
    or delta_item->>'id'<>p_client_message_id::text
    or delta_item->>'createdAt'<>req.receipt->'photo'->>'createdAt'
    or delta_item->>'delivery'<>req.receipt->'photo'->>'delivery'
    or pg_catalog.encode(extensions.digest(pg_catalog.convert_to(delta_item->>'caption','UTF8'),'sha256'),'hex')<>req.caption_digest then
    raise exception 'photo commit does not match durable request' using errcode='22023';
  end if;
  message_id:=(delta_item->>'id')::uuid;
  for index in 0..bubble_count-1 loop
    delta_item:=new_timeline->(old_count+1+index);
    bubble:=req.receipt->'bubbles'->index;
    if delta_item->>'type'<>'message' or delta_item->>'role'<>'assistant'
      or delta_item->>'origin'<>'photo_analysis' or delta_item->>'sourcePhotoMessageId'<>message_id::text
      or delta_item->>'replyGroupId'<>req.receipt->>'replyGroupId'
      or delta_item->>'id'<>bubble->>'id' or delta_item->>'text'<>bubble->>'text'
      or delta_item->>'createdAt'<>bubble->>'createdAt'
      or delta_item->>'delivery'<>bubble->>'delivery'
      or delta_item->>'origin'<>bubble->>'origin'
      or delta_item->>'sourcePhotoMessageId'<>bubble->>'sourcePhotoMessageId'
      or (delta_item->>'sequence')::integer<>(bubble->>'sequence')::integer then
      raise exception 'photo reply does not match durable receipt' using errcode='22023';
    end if;
  end loop;
  update public.photo_assets set attached_message_id=message_id where owner_id=p_owner_id and id=req.photo_id and state='active';
  if not found then raise exception 'photo asset missing' using errcode='P0002'; end if;
  insert into public.chat_snapshots(user_id,version,revision,snapshot,updated_at)
    values(p_owner_id,3,(p_snapshot->>'revision')::bigint,p_snapshot,(p_snapshot->>'updatedAt')::timestamptz)
    on conflict(user_id) do update set version=excluded.version,revision=excluded.revision,snapshot=excluded.snapshot,updated_at=excluded.updated_at
    returning * into saved;
  return saved;
end;
$$;

create or replace function public.request_photo_delete(p_owner_id uuid,p_photo_id uuid,p_reason text)
returns public.photo_deletion_outbox
language plpgsql security definer set search_path=''
as $$
declare asset public.photo_assets; job public.photo_deletion_outbox;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  if p_reason not in ('photo_deleted','chat_deleted','account_deleted','orphaned','ambiguous') then
    raise exception 'invalid photo deletion reason' using errcode='22023';
  end if;
  select * into asset from public.photo_assets where owner_id=p_owner_id and id=p_photo_id for update;
  if not found then raise exception 'photo asset missing' using errcode='P0002'; end if;
  update public.photo_assets set state='blocked',blocked_at=coalesce(blocked_at,now()) where owner_id=p_owner_id and id=p_photo_id;
  update public.photo_requests set caption=null,caption_digest=null,jpeg_digest=null,receipt=null,usage=null,
    lease_owner=null,lease_expires_at=null,request_state='blocked',analysis_state='scrubbed',deletion_state='blocked_from_use',
    blocked_at=coalesce(blocked_at,now()),updated_at=now() where owner_id=p_owner_id and photo_id=p_photo_id;
  insert into public.photo_deletion_outbox(owner_id,photo_id,storage_path,reason)
    values(p_owner_id,p_photo_id,asset.storage_path,p_reason)
    on conflict(owner_id,photo_id) where state<>'verified' do update set next_attempt_at=least(public.photo_deletion_outbox.next_attempt_at,now())
    returning * into job;
  return job;
end;
$$;

create or replace function public.delete_photo_message(p_owner_id uuid,p_photo_id uuid,p_expected_revision bigint,p_snapshot jsonb)
returns public.chat_snapshots
language plpgsql security definer set search_path=''
as $$
declare old public.chat_snapshots; saved public.chat_snapshots; attached uuid; expected_timeline jsonb;
begin
  perform public.assert_photo_service_owner(p_owner_id); perform public.assert_photo_snapshot(p_snapshot);
  select * into old from public.chat_snapshots where user_id=p_owner_id for update;
  select attached_message_id into attached from public.photo_assets where owner_id=p_owner_id and id=p_photo_id for update;
  if not found or old.revision<>p_expected_revision or (p_snapshot->>'revision')::bigint<>p_expected_revision+1 then
    raise exception 'snapshot revision mismatch' using errcode='40001';
  end if;
  if (select count(*) from jsonb_array_elements(old.snapshot->'timeline') item
      where item->>'type'='photo' and item->>'photoId'=p_photo_id::text and item->>'id'=attached::text)<>1 then
    raise exception 'photo message binding mismatch' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(item order by ord),'[]'::jsonb) into expected_timeline
    from jsonb_array_elements(old.snapshot->'timeline') with ordinality t(item,ord)
    where item->>'id'<>attached::text;
  if p_snapshot->'timeline' is distinct from expected_timeline
    or public.photo_snapshot_refs(old.snapshot,'analysis') <> public.photo_snapshot_refs(p_snapshot,'analysis') then
    raise exception 'invalid dedicated photo deletion' using errcode='22023';
  end if;
  perform public.request_photo_delete(p_owner_id,p_photo_id,'photo_deleted');
  update public.chat_snapshots set version=3,revision=(p_snapshot->>'revision')::bigint,snapshot=p_snapshot,
    updated_at=(p_snapshot->>'updatedAt')::timestamptz where user_id=p_owner_id returning * into saved;
  return saved;
end;
$$;

create or replace function public.delete_whole_chat(p_owner_id uuid,p_expected_revision bigint)
returns void language plpgsql security definer set search_path=''
as $$
declare p uuid;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  if not exists(select 1 from public.chat_snapshots where user_id=p_owner_id and revision=p_expected_revision for update) then
    raise exception 'snapshot revision mismatch' using errcode='40001';
  end if;
  for p in select id from public.photo_assets where owner_id=p_owner_id and state='active' loop
    perform public.request_photo_delete(p_owner_id,p,'chat_deleted');
  end loop;
  delete from public.chat_snapshots where user_id=p_owner_id;
end;
$$;

create or replace function public.claim_photo_cleanup_batch(p_lease_owner text,p_limit integer,p_lease_ms integer)
returns setof public.photo_deletion_outbox
language plpgsql security definer set search_path=''
as $$
begin
  if (select auth.role())<>'service_role' or p_lease_owner is null or p_limit not between 1 and 50 or p_lease_ms<=0 then
    raise exception 'photo cleanup server operation required' using errcode='42501';
  end if;
  return query with due as (
    select id from public.photo_deletion_outbox
    where state in ('requested','deleting','deleted') and next_attempt_at<=now()
      and (lease_expires_at is null or lease_expires_at<=now())
    order by requested_at,id for update skip locked limit p_limit
  ) update public.photo_deletion_outbox o set state=case when o.state='deleted' then 'deleted' else 'deleting' end,lease_owner=p_lease_owner,
      lease_expires_at=now()+pg_catalog.make_interval(secs=>p_lease_ms/1000.0),attempts=o.attempts+1
    from due where o.id=due.id returning o.*;
end;
$$;

create or replace function public.register_orphan_photo(p_owner_id uuid,p_photo_id uuid,p_storage_path text)
returns boolean language plpgsql security definer set search_path=''
as $$
declare expected text:=p_owner_id::text||'/'||p_photo_id::text||'.jpg'; referenced boolean;
begin
  perform public.assert_photo_service_owner(p_owner_id);
  if p_storage_path is distinct from expected then raise exception 'invalid orphan photo path' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text||':'||p_photo_id::text,0));
  perform 1 from public.photo_requests where owner_id=p_owner_id and photo_id=p_photo_id for update;
  referenced:=found;
  perform 1 from public.photo_assets where owner_id=p_owner_id and id=p_photo_id for update;
  referenced:=referenced or found;
  if referenced then return false; end if;
  insert into public.photo_deletion_outbox(owner_id,photo_id,storage_path,reason)
    values(p_owner_id,p_photo_id,p_storage_path,'orphaned')
    on conflict(owner_id,photo_id) where state<>'verified' do update set next_attempt_at=least(public.photo_deletion_outbox.next_attempt_at,now());
  return true;
end;
$$;

create or replace function public.complete_photo_delete(p_id uuid,p_lease_owner text,p_object_absent boolean)
returns public.photo_deletion_outbox
language plpgsql security definer set search_path=''
as $$
declare job public.photo_deletion_outbox; stamp timestamptz:=now();
begin
  if (select auth.role())<>'service_role' then raise exception 'photo cleanup server operation required' using errcode='42501'; end if;
  select * into job from public.photo_deletion_outbox where id=p_id for update;
  if not found or job.lease_owner is distinct from p_lease_owner or job.lease_expires_at<=now() then
    raise exception 'photo cleanup lease mismatch' using errcode='42501';
  end if;
  if p_object_absent then
    update public.photo_deletion_outbox set state='verified',deleted_at=coalesce(deleted_at,stamp),verified_at=stamp,
      lease_owner=null,lease_expires_at=null where id=p_id returning * into job;
    update public.photo_assets set state='verified',deleted_at=coalesce(deleted_at,job.deleted_at),verified_at=stamp
      where owner_id=job.owner_id and id=job.photo_id;
    update public.photo_requests set deletion_state='verified',deleted_at=coalesce(deleted_at,job.deleted_at),verified_at=stamp,updated_at=stamp
      where owner_id=job.owner_id and photo_id=job.photo_id;
  else
    update public.photo_deletion_outbox set state='deleted',deleted_at=coalesce(deleted_at,stamp),
      next_attempt_at=stamp+pg_catalog.make_interval(mins=>least(8,power(2,greatest(job.attempts-1,0)))::integer),
      lease_owner=null,lease_expires_at=null
      where id=p_id returning * into job;
    update public.photo_assets set state='deleted',deleted_at=job.deleted_at where owner_id=job.owner_id and id=job.photo_id;
    update public.photo_requests set deletion_state='deleted',deleted_at=job.deleted_at,updated_at=stamp where owner_id=job.owner_id and photo_id=job.photo_id;
  end if;
  return job;
end;
$$;

create or replace function public.get_photo_scan_cursor(p_owner_id uuid)
returns text language plpgsql security definer set search_path=''
as $$ begin perform public.assert_photo_service_owner(p_owner_id); return (select cursor from public.photo_storage_scan_cursors where owner_id=p_owner_id); end; $$;
create or replace function public.save_photo_scan_cursor(p_owner_id uuid,p_cursor text)
returns void language plpgsql security definer set search_path=''
as $$ begin perform public.assert_photo_service_owner(p_owner_id); insert into public.photo_storage_scan_cursors(owner_id,cursor) values(p_owner_id,p_cursor) on conflict(owner_id) do update set cursor=excluded.cursor,updated_at=now(); end; $$;

create or replace function public.photo_asset_before_delete()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  update public.photo_requests set caption=null,caption_digest=null,jpeg_digest=null,receipt=null,usage=null,lease_owner=null,
    lease_expires_at=null,request_state='blocked',analysis_state='scrubbed',deletion_state='blocked_from_use',blocked_at=coalesce(blocked_at,now()),updated_at=now()
    where owner_id=old.owner_id and photo_id=old.id;
  insert into public.photo_deletion_outbox(owner_id,photo_id,storage_path,reason)
    values(old.owner_id,old.id,old.storage_path,'account_deleted')
    on conflict(owner_id,photo_id) where state<>'verified' do nothing;
  return old;
end;
$$;
drop trigger if exists photo_asset_account_delete_outbox on public.photo_assets;
create trigger photo_asset_account_delete_outbox before delete on public.photo_assets
for each row execute function public.photo_asset_before_delete();

revoke all on function public.assert_photo_service_owner(uuid) from public,anon,authenticated;
revoke all on function public.is_photo_uuid_v4(text) from public,anon,authenticated;
revoke all on function public.is_photo_digest(text) from public,anon,authenticated;
revoke all on function public.is_photo_canonical_timestamp(text) from public,anon,authenticated;
revoke all on function public.is_photo_canonical_https_url(text) from public,anon,authenticated;
revoke all on function public.is_photo_canonical_local_date(text) from public,anon,authenticated;
revoke all on function public.assert_photo_receipt(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.assert_photo_snapshot(jsonb) from public,anon,authenticated;
revoke all on function public.photo_snapshot_refs(jsonb,text) from public,anon,authenticated;
revoke all on function public.claim_photo_request(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.begin_photo_upload(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.complete_photo_upload(uuid,uuid,text,text,bigint) from public,anon,authenticated;
revoke all on function public.claim_photo_analysis(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.complete_photo_analysis(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.fail_photo_request(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.get_active_photo(uuid,uuid) from public,anon,authenticated;
revoke all on function public.save_chat_snapshot_reconciled(uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.commit_photo_exchange(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.delete_photo_message(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.delete_whole_chat(uuid,bigint) from public,anon,authenticated;
revoke all on function public.request_photo_delete(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.claim_photo_cleanup_batch(text,integer,integer) from public,anon,authenticated;
revoke all on function public.register_orphan_photo(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.complete_photo_delete(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.get_photo_scan_cursor(uuid) from public,anon,authenticated;
revoke all on function public.save_photo_scan_cursor(uuid,text) from public,anon,authenticated;

grant execute on function public.assert_photo_service_owner(uuid) to service_role;
grant execute on function public.is_photo_uuid_v4(text) to service_role;
grant execute on function public.is_photo_digest(text) to service_role;
grant execute on function public.is_photo_canonical_timestamp(text) to service_role;
grant execute on function public.is_photo_canonical_https_url(text) to service_role;
grant execute on function public.is_photo_canonical_local_date(text) to service_role;
grant execute on function public.assert_photo_receipt(uuid,jsonb) to service_role;
grant execute on function public.assert_photo_snapshot(jsonb) to service_role;
grant execute on function public.photo_snapshot_refs(jsonb,text) to service_role;
grant execute on function public.claim_photo_request(uuid,uuid,text,text,text) to service_role;
grant execute on function public.begin_photo_upload(uuid,uuid,text) to service_role;
grant execute on function public.complete_photo_upload(uuid,uuid,text,text,bigint) to service_role;
grant execute on function public.claim_photo_analysis(uuid,uuid,text) to service_role;
grant execute on function public.complete_photo_analysis(uuid,uuid,text,jsonb,jsonb) to service_role;
grant execute on function public.fail_photo_request(uuid,uuid,text,boolean) to service_role;
grant execute on function public.get_active_photo(uuid,uuid) to service_role;
grant execute on function public.save_chat_snapshot_reconciled(uuid,bigint,jsonb) to service_role;
grant execute on function public.commit_photo_exchange(uuid,uuid,bigint,jsonb) to service_role;
grant execute on function public.delete_photo_message(uuid,uuid,bigint,jsonb) to service_role;
grant execute on function public.delete_whole_chat(uuid,bigint) to service_role;
grant execute on function public.request_photo_delete(uuid,uuid,text) to service_role;
grant execute on function public.claim_photo_cleanup_batch(text,integer,integer) to service_role;
grant execute on function public.register_orphan_photo(uuid,uuid,text) to service_role;
grant execute on function public.complete_photo_delete(uuid,text,boolean) to service_role;
grant execute on function public.get_photo_scan_cursor(uuid) to service_role;
grant execute on function public.save_photo_scan_cursor(uuid,text) to service_role;
