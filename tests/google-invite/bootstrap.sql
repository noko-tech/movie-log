-- ONLY for a fresh, disposable test cluster; never run against an existing DB.
CREATE ROLE postgres LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE migration_runner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT postgres TO migration_runner WITH SET TRUE, INHERIT FALSE;
GRANT CREATE ON DATABASE postgres TO postgres;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE supabase_auth_admin NOLOGIN NOBYPASSRLS;

-- Deliberately permissive defaults, as can exist on Supabase projects.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON TABLES
  TO anon, authenticated, service_role, supabase_auth_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON FUNCTIONS
  TO anon, authenticated, service_role, supabase_auth_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON SCHEMAS
  TO anon, authenticated, service_role, supabase_auth_admin;

-- Synthetic preservation fixtures, NOT downloaded production definitions/data.
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text NOT NULL);
INSERT INTO auth.users VALUES
  ('00000000-0000-4000-8000-000000000001', 'existing@example.invalid');
CREATE TABLE public.movie_logs (id integer PRIMARY KEY, user_id uuid, title text);
INSERT INTO public.movie_logs VALUES
  (1, '00000000-0000-4000-8000-000000000001', 'SYNTHETIC_MOVIE');
ALTER TABLE public.movie_logs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.movie_logs TO authenticated;
CREATE POLICY fixture_movie_policy ON public.movie_logs FOR SELECT
  TO authenticated USING (false);
CREATE FUNCTION public.fixture_movie_rpc() RETURNS integer LANGUAGE sql AS 'SELECT 42';

CREATE SCHEMA preservation_fixture;
CREATE FUNCTION preservation_fixture.snapshot() RETURNS jsonb
LANGUAGE sql AS $snapshot$
  SELECT jsonb_build_object(
    'users', (SELECT jsonb_agg(u ORDER BY id) FROM auth.users u),
    'movies', (SELECT jsonb_agg(m ORDER BY id) FROM public.movie_logs m),
    'tables', (SELECT jsonb_agg(t ORDER BY nspname, relname) FROM (
      SELECT n.nspname, c.relname, c.relowner, c.relacl, c.relrowsecurity,
        c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('auth', 'public') AND c.relkind IN ('r','i','S')
    ) t),
    'policies', (SELECT jsonb_agg(p ORDER BY policyname) FROM pg_policies p
      WHERE schemaname IN ('auth', 'public')),
    'rpc', pg_get_functiondef('public.fixture_movie_rpc()'::regprocedure),
    'rpc_acl', (SELECT proacl FROM pg_proc WHERE oid='public.fixture_movie_rpc()'::regprocedure),
    'triggers', (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('auth', 'public'))
  );
$snapshot$;
CREATE TABLE preservation_fixture.baseline AS
  SELECT preservation_fixture.snapshot() AS value;
