-- Movie objects only. No data writes, default-ACL changes, or Auth/TMDb changes.
-- Apply after the four earlier migrations, as postgres or a session allowed
-- to SET ROLE postgres. Unexpected owners/overloads/remaining grants abort.
BEGIN;
SET LOCAL ROLE postgres;

DO $movie_access$
DECLARE
  rpc_signatures CONSTANT text[] := ARRAY[
    'public.create_movie_log_with_series_order(text, text, timestamp with time zone, bigint, text, text, text, smallint, boolean, text, text, smallint, smallint, text, text, text, text, text, text, text)',
    'public.update_movie_log_with_series_order(uuid, text, timestamp with time zone, text, bigint, text, text, text, smallint, boolean, text, text, smallint, smallint, text, text, text, text, text, text, text)',
    'public.delete_movie_log_with_series_order(uuid, text)'
  ];
  signature text;
  fn_oid oid;
  movie_table oid := pg_catalog.to_regclass('public.movie_logs');
  columns_sql text;
  api_role text;
  privilege text;
  extra_privileges text[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'];
BEGIN
  IF movie_table IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = movie_table AND relkind = 'r'
      AND relowner = 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'MOVIE_ACCESS_UNEXPECTED_TABLE_OR_OWNER';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
        'create_movie_log_with_series_order',
        'update_movie_log_with_series_order',
        'delete_movie_log_with_series_order'
      ])) <> 3 THEN
    RAISE EXCEPTION 'MOVIE_ACCESS_UNEXPECTED_RPC_OVERLOADS';
  END IF;

  -- Check every dependency before changing any ACL or function attribute.
  FOREACH signature IN ARRAY rpc_signatures LOOP
    fn_oid := pg_catalog.to_regprocedure(signature);
    IF fn_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid = fn_oid AND proowner = 'postgres'::regrole
        AND prokind = 'f' AND prorettype = 'jsonb'::regtype
    ) THEN
      RAISE EXCEPTION 'MOVIE_ACCESS_UNEXPECTED_RPC_SIGNATURE_OR_OWNER';
    END IF;
  END LOOP;

  ALTER TABLE public.movie_logs ENABLE ROW LEVEL SECURITY;

  -- A table-level REVOKE alone does not remove independent column grants.
  SELECT pg_catalog.string_agg(pg_catalog.format('%I', attname), ', ' ORDER BY attnum)
    INTO columns_sql
    FROM pg_catalog.pg_attribute
    WHERE attrelid = movie_table AND attnum > 0 AND NOT attisdropped;
  EXECUTE pg_catalog.format(
    'REVOKE ALL PRIVILEGES (%s) ON TABLE public.movie_logs FROM PUBLIC, anon, authenticated, service_role',
    columns_sql
  );
  REVOKE ALL PRIVILEGES ON TABLE public.movie_logs
    FROM PUBLIC, anon, authenticated, service_role;

  -- Browser writes/imports still need direct CRUD; existing RLS scopes them.
  -- Retain the existing server CRUD contract, without TRUNCATE/delegation.
  -- service_role is server-only and bypasses RLS; never send its key to a page.
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.movie_logs
    TO authenticated, service_role;

  FOREACH signature IN ARRAY rpc_signatures LOOP
    -- These functions already reject NULL auth.uid() and scope operations to
    -- that UID. INVOKER also subjects every movie operation to the caller's RLS.
    EXECUTE pg_catalog.format('ALTER FUNCTION %s SECURITY INVOKER', signature);
    EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = %L', signature, '');
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      signature
    );
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO authenticated', signature);

    fn_oid := pg_catalog.to_regprocedure(signature);
    IF NOT pg_catalog.has_function_privilege('authenticated', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'MOVIE_ACCESS_AUTHENTICATED_EXECUTE_MISSING';
    END IF;
    IF pg_catalog.has_function_privilege('authenticated', fn_oid, 'EXECUTE WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'MOVIE_ACCESS_UNEXPECTED_RPC_GRANT_OPTION';
    END IF;
    FOREACH api_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF pg_catalog.has_function_privilege(api_role, pg_catalog.to_regprocedure(signature), 'EXECUTE') THEN
        RAISE EXCEPTION 'MOVIE_ACCESS_UNEXPECTED_RPC_EXECUTE';
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS p,
        LATERAL pg_catalog.aclexplode(p.proacl) AS a
      WHERE p.oid = pg_catalog.to_regprocedure(signature) AND a.grantee = 0
    ) THEN
      RAISE EXCEPTION 'MOVIE_ACCESS_PUBLIC_RPC_GRANT_REMAINS';
    END IF;
  END LOOP;

  IF pg_catalog.current_setting('server_version_num')::integer >= 170000 THEN
    extra_privileges := pg_catalog.array_append(extra_privileges, 'MAINTAIN');
  END IF;
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF pg_catalog.has_any_column_privilege(api_role, movie_table, 'REFERENCES') THEN
      RAISE EXCEPTION 'MOVIE_ACCESS_COLUMN_REFERENCES_REMAINS';
    END IF;
    FOREACH privilege IN ARRAY extra_privileges LOOP
      IF pg_catalog.has_table_privilege(api_role, movie_table, privilege) THEN
        RAISE EXCEPTION 'MOVIE_ACCESS_UNEXPECTED_EXTRA_TABLE_PRIVILEGE';
      END IF;
    END LOOP;
    FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF pg_catalog.has_table_privilege(api_role, movie_table, privilege)
          IS DISTINCT FROM (api_role <> 'anon') THEN
        RAISE EXCEPTION 'MOVIE_ACCESS_UNEXPECTED_CRUD_PRIVILEGE';
      END IF;
      IF pg_catalog.has_table_privilege(api_role, movie_table, privilege || ' WITH GRANT OPTION') THEN
        RAISE EXCEPTION 'MOVIE_ACCESS_UNEXPECTED_GRANT_OPTION';
      END IF;
    END LOOP;
  END LOOP;
  FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
    IF pg_catalog.has_any_column_privilege('anon', movie_table, privilege) THEN
      RAISE EXCEPTION 'MOVIE_ACCESS_ANON_COLUMN_GRANT_REMAINS';
    END IF;
  END LOOP;
END;
$movie_access$;

NOTIFY pgrst, 'reload schema';
COMMIT;
