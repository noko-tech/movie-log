-- Run only through run.py --run-disposable-db, not in an existing Supabase DB.
BEGIN;
SELECT movie_access_test.check(
  (SELECT value FROM movie_access_test.baseline) = movie_access_test.preserved(),
  'migration preserves rows, RPC bodies, policies, triggers, Auth, TMDb and defaults');

DO $$
DECLARE r text; p text; f record;
BEGIN
  FOR f IN SELECT p.oid,p.prosecdef,p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'create_movie_log_with_series_order','update_movie_log_with_series_order',
      'delete_movie_log_with_series_order')
  LOOP
    PERFORM movie_access_test.check(NOT f.prosecdef, 'movie RPC is INVOKER');
    PERFORM movie_access_test.check('search_path=""'=ANY(f.proconfig), 'movie RPC pins empty search_path');
    PERFORM movie_access_test.check(has_function_privilege('authenticated',f.oid,'EXECUTE'),
      'authenticated can execute movie RPC');
    PERFORM movie_access_test.check(NOT has_function_privilege('authenticated',f.oid,'EXECUTE WITH GRANT OPTION'),
      'authenticated cannot delegate movie RPC');
    FOREACH r IN ARRAY ARRAY['anon','service_role'] LOOP
      PERFORM movie_access_test.check(NOT has_function_privilege(r,f.oid,'EXECUTE'),
        r||' cannot execute movie RPC');
    END LOOP;
    PERFORM movie_access_test.check(NOT EXISTS (
      SELECT 1 FROM pg_proc p,LATERAL aclexplode(p.proacl) a
      WHERE p.oid=f.oid AND a.grantee=0), 'PUBLIC has no movie RPC grant');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      PERFORM movie_access_test.check(
        has_table_privilege(r,'public.movie_logs',p)=(r<>'anon'),r||' CRUD '||p);
      PERFORM movie_access_test.check(
        NOT has_table_privilege(r,'public.movie_logs',p||' WITH GRANT OPTION'),r||' cannot delegate '||p);
    END LOOP;
    FOREACH p IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
      PERFORM movie_access_test.check(NOT has_table_privilege(r,'public.movie_logs',p),
        r||' lacks extra table privilege '||p);
    END LOOP;
  END LOOP;
  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
    PERFORM movie_access_test.check(NOT has_any_column_privilege('anon','public.movie_logs',p),
      'anon has no leftover column grant '||p);
  END LOOP;
END;
$$;
SELECT movie_access_test.check(
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.movie_logs'::regclass), 'movie RLS enabled');

-- Supplying even a forged subject does not let anon cross the EXECUTE ACL.
SET ROLE anon;
SELECT movie_access_test.check(current_user='anon','anonymous tests use anon');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SELECT movie_access_test.denied('SELECT * FROM public.movie_logs','anon SELECT denied');
SELECT movie_access_test.denied('INSERT INTO public.movie_logs(user_id,title) VALUES (NULL,''FORBIDDEN'')',
  'anon INSERT denied');
SELECT movie_access_test.denied('UPDATE public.movie_logs SET title=''FORBIDDEN''','anon UPDATE denied');
SELECT movie_access_test.denied('DELETE FROM public.movie_logs','anon DELETE denied');
SELECT movie_access_test.denied('TRUNCATE public.movie_logs','anon TRUNCATE denied');
SELECT movie_access_test.denied(
  'SELECT public.create_movie_log_with_series_order(''forbidden'',''FORBIDDEN'',now())',
  'anon create RPC denied despite supplied subject');
SELECT movie_access_test.denied(
  'SELECT movie_access_test.update_movie(NULL,NULL,NULL,''FORBIDDEN'')','anon update RPC denied');
SELECT movie_access_test.denied(
  'SELECT public.delete_movie_log_with_series_order(NULL,NULL)','anon delete RPC denied');
RESET ROLE;

-- EXECUTE alone is not authentication: every RPC also rejects an absent UID.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT movie_access_test.check(current_user='authenticated' AND auth.uid() IS NULL,
  'missing UID tests use authenticated without an identity');
SELECT movie_access_test.denied(
  'SELECT public.create_movie_log_with_series_order(''forbidden'',''FORBIDDEN'',now())',
  'authenticated without UID cannot create');
SELECT movie_access_test.denied(
  'SELECT movie_access_test.update_movie(NULL,NULL,NULL,''FORBIDDEN'')',
  'authenticated without UID cannot update');
SELECT movie_access_test.denied(
  'SELECT public.delete_movie_log_with_series_order(NULL,NULL)',
  'authenticated without UID cannot delete');
SELECT movie_access_test.check((SELECT count(*)=0 FROM public.movie_logs), 'missing UID reads no movie rows');

-- B knows A's UUID, legacy ID and timestamp. RLS/RPCs still hide A's data.
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
SELECT movie_access_test.check((SELECT count(*)=1 AND min(title)='MOVIE_B' FROM public.movie_logs),
  'B reads only B movies');
SELECT movie_access_test.check((SELECT count(*)=0 FROM public.movie_logs
  WHERE id='10000000-0000-4000-8000-000000000001'), 'B cannot SELECT A by known ID');
SELECT movie_access_test.check((movie_access_test.update_movie(
  '10000000-0000-4000-8000-000000000001','fixture-a','2026-01-01T00:00:00Z','FORBIDDEN')->>'status')='not_found',
  'B update RPC does not reveal or modify A');
SELECT movie_access_test.check((public.delete_movie_log_with_series_order(
  '10000000-0000-4000-8000-000000000001','fixture-a')->>'status')='not_found',
  'B delete RPC does not reveal or delete A');
DO $$
DECLARE changed integer;
BEGIN
  UPDATE public.movie_logs SET title='FORBIDDEN'
    WHERE id='10000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS changed=ROW_COUNT;
  PERFORM movie_access_test.check(changed=0,'B direct UPDATE of A affects zero rows');
  DELETE FROM public.movie_logs WHERE id='10000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS changed=ROW_COUNT;
  PERFORM movie_access_test.check(changed=0,'B direct DELETE of A affects zero rows');
END;
$$;
SELECT movie_access_test.denied(
  'INSERT INTO public.movie_logs(user_id,title) VALUES (''00000000-0000-4000-8000-000000000001'',''FORBIDDEN'')',
  'B cannot INSERT a row owned by A');
SELECT movie_access_test.denied(
  'UPDATE public.movie_logs SET user_id=''00000000-0000-4000-8000-000000000001'' WHERE legacy_local_id=''fixture-b''',
  'B cannot transfer ownership to A');
SELECT movie_access_test.denied('TRUNCATE public.movie_logs','authenticated TRUNCATE denied despite RLS bypass for truncate');
RESET ROLE;
SELECT movie_access_test.check(
  (SELECT value FROM movie_access_test.baseline) = movie_access_test.preserved(),
  'all anonymous and cross-user attempts leave every fixture unchanged');

-- Positive tests prevent an ACL change that simply disables every operation.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
SELECT movie_access_test.check((public.create_movie_log_with_series_order(
  p_legacy_local_id=>'a-new',p_title=>'A_NEW',p_created_at=>now(),
  p_year=>2021::smallint,p_series_name=>'SERIES')->'movie'->>'user_id')=
  '00000000-0000-4000-8000-000000000001', 'A creates own movie through RPC');
SELECT movie_access_test.check((SELECT count(*)=2 FROM public.movie_logs), 'A still reads only A movies');
SELECT movie_access_test.check((SELECT title='A_NEW' AND year=2021 AND series_order=2
  FROM public.movie_logs WHERE legacy_local_id='a-new'),'create persists values and own series order');
SELECT movie_access_test.check((movie_access_test.update_movie(
  '10000000-0000-4000-8000-000000000001','fixture-a',
  (SELECT updated_at FROM public.movie_logs WHERE legacy_local_id='fixture-a'),'A_UPDATED')->>'status')='updated',
  'A updates own movie through RPC');
SELECT movie_access_test.check((SELECT title='A_UPDATED' AND updated_at<>'2026-01-01T00:00:00Z'::timestamptz
  FROM public.movie_logs WHERE legacy_local_id='fixture-a'),'update persists values and timestamp trigger runs');
SELECT movie_access_test.check((public.delete_movie_log_with_series_order(
  '10000000-0000-4000-8000-000000000001','fixture-a')->>'status')='deleted', 'A deletes own movie through RPC');
SELECT movie_access_test.check(NOT EXISTS (SELECT 1 FROM public.movie_logs
  WHERE id='10000000-0000-4000-8000-000000000001'), 'deleted row is absent');
INSERT INTO public.movie_logs(user_id,legacy_local_id,title)
VALUES ('00000000-0000-4000-8000-000000000001','direct-a','DIRECT_A');
UPDATE public.movie_logs SET title='DIRECT_A_UPDATED' WHERE legacy_local_id='direct-a';
SELECT movie_access_test.check((SELECT title='DIRECT_A_UPDATED' FROM public.movie_logs
  WHERE legacy_local_id='direct-a'),'own direct CRUD remains available');
DELETE FROM public.movie_logs WHERE legacy_local_id='direct-a';
RESET ROLE;
SELECT movie_access_test.check((SELECT to_jsonb(m) FROM public.movie_logs m WHERE legacy_local_id='fixture-b') =
  (SELECT row_value FROM movie_access_test.baseline,
    LATERAL jsonb_array_elements(value->'movies') AS baseline_movies(row_value)
    WHERE row_value->>'legacy_local_id'='fixture-b'),
  'A operations and series reordering preserve every B column');

-- Compatibility: the Auth-only hook still reads both private tables.
SET ROLE supabase_auth_admin;
SELECT movie_access_test.check(google_invite_private.before_user_created('{
  "metadata":{"name":"before-user-created"},
  "user":{"id":"00000000-0000-4000-8000-000000000003","email":"invited@example.invalid",
    "is_anonymous":false,"app_metadata":{"provider":"google","providers":["google"]}}
}'::jsonb)='{}'::jsonb,'Auth hook still permits an invited synthetic Google event');
RESET ROLE;
SET ROLE authenticated;
SELECT movie_access_test.denied('SELECT * FROM google_invite_private.invitations','movie user cannot read invitations');
SELECT movie_access_test.denied('SELECT public.consume_tmdb_rate_limit(NULL)','movie user cannot call server rate limiter');
RESET ROLE;
SET ROLE service_role;
SELECT movie_access_test.check((SELECT count(*)=2 FROM public.movie_logs),'server-only CRUD contract preserved');
SELECT movie_access_test.denied('TRUNCATE public.movie_logs','server TRUNCATE removed');
SELECT movie_access_test.denied('SELECT public.delete_movie_log_with_series_order(NULL,NULL)',
  'server BYPASSRLS does not grant movie RPC EXECUTE');
SELECT movie_access_test.check((public.consume_tmdb_rate_limit(
  '00000000-0000-4000-8000-000000000001')->>'allowed')::boolean,'TMDb server rate limiter still works');
RESET ROLE;
ROLLBACK;
