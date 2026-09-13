begin;
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.assert_photo_snapshot(jsonb)'::regprocedure) into definition;
 if position('''drive-results''' in definition)>0 then return; end if;
 if position('''google-items'',''google-operation'',''weather'',''maps'',''home-candidates''' in definition)=0 then raise exception 'unsupported snapshot validator'; end if;
 definition:=replace(definition,'''google-items'',''google-operation'',''weather'',''maps'',''home-candidates''','''google-items'',''google-operation'',''weather'',''maps'',''home-candidates'',''drive-results'',''drive-content''');
 execute definition;
end $migration$;
commit;
