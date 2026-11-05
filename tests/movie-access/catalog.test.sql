-- No operation should pass merely because the test runs as a superuser.
BEGIN;
SELECT movie_access_test.check(
  (SELECT NOT rolsuper AND NOT rolbypassrls AND rolcreaterole
   FROM pg_roles WHERE rolname='postgres'), 'migration postgres is not a superuser or RLS bypass role');
SELECT movie_access_test.check(
  (SELECT count(*)=0 FROM pg_roles WHERE rolname IN ('anon','authenticated','supabase_auth_admin')
    AND (rolsuper OR rolbypassrls OR rolcanlogin)), 'client and Auth roles have no superuser or RLS bypass');
DO $$
DECLARE expected record; actual record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public','movie_logs','postgres',4),
    ('google_invite_private','invitations','postgres',1),
    ('google_invite_private','signup_policy','postgres',1),
    ('tmdb_rate_limit_private','settings','tmdb_rate_limiter_owner',0),
    ('tmdb_rate_limit_private','events','tmdb_rate_limiter_owner',0)
  ) AS x(schema_name,table_name,owner_name,policy_count)
  LOOP
    SELECT c.relowner,c.relrowsecurity,c.relforcerowsecurity,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policy_count
    INTO STRICT actual FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=expected.schema_name AND c.relname=expected.table_name AND c.relkind='r';
    PERFORM movie_access_test.check(actual.relowner=expected.owner_name::regrole,
      'table owner '||expected.schema_name||'.'||expected.table_name);
    PERFORM movie_access_test.check(actual.relrowsecurity AND NOT actual.relforcerowsecurity,
      'RLS enabled without changing administrator owner semantics');
    PERFORM movie_access_test.check(actual.policy_count=expected.policy_count,'expected policy count');
  END LOOP;
  FOR expected IN SELECT * FROM (VALUES
    ('public','create_movie_log_with_series_order','postgres',false),
    ('public','update_movie_log_with_series_order','postgres',false),
    ('public','delete_movie_log_with_series_order','postgres',false),
    ('public','set_movie_logs_updated_at','postgres',false),
    ('google_invite_private','before_user_created','postgres',false),
    ('public','consume_tmdb_rate_limit','postgres',false),
    ('tmdb_rate_limit_private','consume_internal','tmdb_rate_limiter_owner',true)
  ) AS x(schema_name,function_name,owner_name,is_definer)
  LOOP
    SELECT p.proowner,p.prosecdef INTO STRICT actual FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=expected.schema_name AND p.proname=expected.function_name;
    PERFORM movie_access_test.check(actual.proowner=expected.owner_name::regrole,'expected function owner');
    PERFORM movie_access_test.check(actual.prosecdef=expected.is_definer,'expected function execution identity');
  END LOOP;
END;
$$;
SELECT movie_access_test.check((SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
  FROM pg_roles WHERE rolname='tmdb_rate_limiter_owner'), 'TMDb DEFINER uses a dedicated non-login owner');
SELECT movie_access_test.check((SELECT count(*)=2 FROM auth.users),'only two synthetic users exist');
SELECT movie_access_test.check(to_regprocedure('public.restore_movie_logs_from_backup(jsonb)') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='restore_movie_logs_from_backup'),
  'backup restore remains unimplemented; not a tested feature');
SET LOCAL ROLE authenticated;
SELECT movie_access_test.check(current_user='authenticated' AND
  (SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user) AND
  (SELECT relowner<>current_user::regrole FROM pg_class WHERE oid='public.movie_logs'::regclass),
  'authenticated tests execute as a non-owner subject to RLS');
ROLLBACK;
