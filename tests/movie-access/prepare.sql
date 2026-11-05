-- Test helpers and preservation snapshot, shared by both installation paths.
-- Does not change any application function attribute or application ACL.
SET ROLE postgres;
CREATE FUNCTION public.unrelated_movie_access_fixture() RETURNS integer
LANGUAGE sql AS 'SELECT 42';
RESET ROLE;

CREATE SCHEMA movie_access_test;
GRANT USAGE ON SCHEMA movie_access_test TO anon, authenticated, service_role, supabase_auth_admin;
CREATE FUNCTION movie_access_test.check(ok boolean, label text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %', label; END IF;
  RAISE NOTICE 'PASS %', label;
END;
$$;
CREATE FUNCTION movie_access_test.denied(statement text, label text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  BEGIN
    EXECUTE statement;
    RAISE EXCEPTION 'FAIL unexpected permission: %', label;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS %', label;
  END;
END;
$$;
CREATE FUNCTION movie_access_test.update_movie(
  movie_id uuid, legacy_id text, expected_time timestamptz, title text
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER AS $$
  SELECT public.update_movie_log_with_series_order(
    p_movie_id=>movie_id, p_expected_legacy_local_id=>legacy_id,
    p_expected_updated_at=>expected_time, p_title=>title,
    p_tmdb_id=>NULL, p_media_type=>'movie', p_poster_url=>NULL, p_overview=>NULL,
    p_rating=>0::smallint, p_favorite=>false, p_status=>'watched', p_genre=>NULL,
    p_year=>2020::smallint, p_runtime=>NULL, p_country=>NULL, p_director=>NULL,
    p_writer=>NULL, p_cast=>NULL, p_watch_date=>NULL, p_comment=>NULL,
    p_series_name=>'SERIES');
$$;

-- The before/after snapshot excludes only the ACLs/attributes being changed.
CREATE FUNCTION movie_access_test.preserved() RETURNS jsonb
LANGUAGE sql SECURITY INVOKER AS $$
  SELECT jsonb_build_object(
    'users',(SELECT jsonb_agg(u ORDER BY id) FROM auth.users u),
    'movies',(SELECT jsonb_agg(m ORDER BY id) FROM public.movie_logs m),
    'invitations',(SELECT jsonb_agg(i ORDER BY email) FROM google_invite_private.invitations i),
    'signup_policy',(SELECT jsonb_agg(s) FROM google_invite_private.signup_policy s),
    'rate_settings',(SELECT jsonb_agg(s) FROM tmdb_rate_limit_private.settings s),
    'rate_events',(SELECT jsonb_agg(e ORDER BY id) FROM tmdb_rate_limit_private.events e),
    'bodies',(SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'body',p.prosrc) ORDER BY p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','auth','google_invite_private','tmdb_rate_limit_private')),
    'other_functions',(SELECT jsonb_agg(jsonb_build_object(
        'oid',p.oid,'definition',pg_get_functiondef(p.oid),'acl',p.proacl) ORDER BY p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','auth','google_invite_private','tmdb_rate_limit_private')
        AND p.proname NOT IN ('create_movie_log_with_series_order',
          'update_movie_log_with_series_order','delete_movie_log_with_series_order')),
    'other_tables',(SELECT jsonb_agg(jsonb_build_object(
        'oid',c.oid,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity) ORDER BY c.oid)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('auth','google_invite_private','tmdb_rate_limit_private')
        AND c.relkind IN ('r','S')),
    'schemas',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'acl',nspacl) ORDER BY oid)
      FROM pg_namespace WHERE nspname IN ('public','auth','google_invite_private','tmdb_rate_limit_private')),
    'defaults',(SELECT jsonb_agg(d ORDER BY oid) FROM pg_default_acl d),
    'policies',(SELECT jsonb_agg(p ORDER BY oid) FROM pg_policy p),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY oid)
      FROM pg_trigger WHERE tgrelid='public.movie_logs'::regclass));
$$;
CREATE TABLE movie_access_test.baseline AS SELECT movie_access_test.preserved() AS value;
