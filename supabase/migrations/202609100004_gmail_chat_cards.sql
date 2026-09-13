begin;
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.assert_photo_snapshot(jsonb)'::regprocedure) into definition;
 if position('''gmail-results''' in definition)>0 then return; end if;
 if position('''drive-results'',''drive-content''' in definition)=0 then raise exception 'unsupported snapshot validator'; end if;
 definition:=replace(definition,'''drive-results'',''drive-content''','''drive-results'',''drive-content'',''gmail-results'',''gmail-content'',''gmail-draft''');
 execute definition;
end $migration$;
commit;
