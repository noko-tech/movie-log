-- Synthetic bootstrap for a NEW disposable PostgreSQL cluster only.
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE supabase_auth_admin NOLOGIN NOBYPASSRLS;
GRANT CREATE ON DATABASE postgres TO postgres;
GRANT USAGE, CREATE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text NOT NULL);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;
GRANT REFERENCES ON TABLE auth.users TO postgres;
-- Keep auth.users empty until the clean-install migrations have completed.

-- Simulate automatic RLS for public tables. The migrations still enable RLS
-- explicitly for private tables. This does not create any allow-all policy.
CREATE FUNCTION auto_rls_fixture() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF cmd.schema_name = 'public' AND cmd.object_type = 'table' THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', cmd.object_identity);
    END IF;
  END LOOP;
END;
$$;
CREATE EVENT TRIGGER auto_rls_fixture ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS')
  EXECUTE FUNCTION auto_rls_fixture();
