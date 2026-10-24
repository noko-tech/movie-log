-- Apply only after review. No existing movie tables, policies or RPCs are changed.
-- Requires PostgreSQL 16+, the Supabase migration administrator (postgres),
-- and built-in API roles. The session must be allowed to SET ROLE postgres.
-- Names intentionally fail on collision instead of reusing an unknown object.
BEGIN;
SET LOCAL ROLE postgres;

CREATE ROLE tmdb_rate_limiter_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
-- PostgreSQL 16+ separately grants the creator ADMIN with SET/INHERIT false.
-- Add only temporary SET permission; do not inherit the owner's data access.
GRANT tmdb_rate_limiter_owner TO postgres WITH SET TRUE, INHERIT FALSE;
CREATE SCHEMA tmdb_rate_limit_private AUTHORIZATION tmdb_rate_limiter_owner;
SET LOCAL ROLE tmdb_rate_limiter_owner;
REVOKE ALL ON SCHEMA tmdb_rate_limit_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE tmdb_rate_limit_private.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_per_minute integer NOT NULL DEFAULT 60 CHECK (user_per_minute BETWEEN 1 AND 10000),
  global_per_minute integer NOT NULL DEFAULT 300 CHECK (global_per_minute BETWEEN 1 AND 100000),
  user_per_10_seconds integer NOT NULL DEFAULT 10 CHECK (user_per_10_seconds BETWEEN 1 AND 10000)
);
INSERT INTO tmdb_rate_limit_private.settings (singleton) VALUES (true);

CREATE TABLE tmdb_rate_limit_private.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX tmdb_rate_events_time ON tmdb_rate_limit_private.events (happened_at DESC);
CREATE INDEX tmdb_rate_events_user_time ON tmdb_rate_limit_private.events (user_id, happened_at DESC);

ALTER TABLE tmdb_rate_limit_private.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tmdb_rate_limit_private.events ENABLE ROW LEVEL SECURITY;
-- No API-role policies. Only the NOLOGIN table owner, through the RPC, writes.
REVOKE ALL ON TABLE tmdb_rate_limit_private.settings, tmdb_rate_limit_private.events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE tmdb_rate_limit_private.events_id_seq FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION tmdb_rate_limit_private.consume_internal(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '500ms'
AS $$
DECLARE
  limits tmdb_rate_limit_private.settings%ROWTYPE;
  checked_at timestamptz;
  retry_at timestamptz;
  expires_at timestamptz;
  user_count bigint;
  global_count bigint;
  short_count bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;

  -- The same row serializes ALL callers and configuration changes. VOLATILE
  -- uses fresh READ COMMITTED snapshots after waiting for another transaction.
  SELECT * INTO STRICT limits FROM tmdb_rate_limit_private.settings
    WHERE singleton FOR UPDATE;
  checked_at := pg_catalog.clock_timestamp();
  DELETE FROM tmdb_rate_limit_private.events
    WHERE happened_at <= checked_at - INTERVAL '60 seconds';

  SELECT count(*), count(*) FILTER (WHERE user_id = p_user_id),
    count(*) FILTER (WHERE user_id = p_user_id AND happened_at > checked_at - INTERVAL '10 seconds')
    INTO global_count, user_count, short_count
    FROM tmdb_rate_limit_private.events;

  retry_at := checked_at;
  IF user_count >= limits.user_per_minute THEN
    SELECT happened_at + INTERVAL '60 seconds' INTO expires_at
      FROM tmdb_rate_limit_private.events WHERE user_id = p_user_id
      ORDER BY happened_at DESC OFFSET (limits.user_per_minute - 1) LIMIT 1;
    retry_at := GREATEST(retry_at, expires_at);
  END IF;
  IF global_count >= limits.global_per_minute THEN
    SELECT happened_at + INTERVAL '60 seconds' INTO expires_at
      FROM tmdb_rate_limit_private.events
      ORDER BY happened_at DESC OFFSET (limits.global_per_minute - 1) LIMIT 1;
    retry_at := GREATEST(retry_at, expires_at);
  END IF;
  IF short_count >= limits.user_per_10_seconds THEN
    SELECT happened_at + INTERVAL '10 seconds' INTO expires_at
      FROM tmdb_rate_limit_private.events
      WHERE user_id = p_user_id AND happened_at > checked_at - INTERVAL '10 seconds'
      ORDER BY happened_at DESC OFFSET (limits.user_per_10_seconds - 1) LIMIT 1;
    retry_at := GREATEST(retry_at, expires_at);
  END IF;

  IF retry_at > checked_at THEN
    RETURN pg_catalog.jsonb_build_object('allowed', false, 'retry_after_seconds',
      GREATEST(1, ceil(EXTRACT(EPOCH FROM retry_at - checked_at))::integer));
  END IF;

  INSERT INTO tmdb_rate_limit_private.events (user_id, happened_at)
    VALUES (p_user_id, checked_at);
  RETURN pg_catalog.jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
END;
$$;

-- USAGE permits function lookup, not direct table/sequence operations. This
-- schema must remain outside the Data API's Exposed schemas configuration.
REVOKE ALL ON FUNCTION tmdb_rate_limit_private.consume_internal(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA tmdb_rate_limit_private TO service_role;
GRANT EXECUTE ON FUNCTION tmdb_rate_limit_private.consume_internal(uuid) TO service_role;

-- The public entry point runs as its caller. Its owner is the migration admin,
-- so the private owner never needs CREATE (even temporarily) on schema public.
SET LOCAL ROLE postgres;
CREATE FUNCTION public.consume_tmdb_rate_limit(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN tmdb_rate_limit_private.consume_internal(p_user_id);
END;
$$;

-- Defaults may grant PUBLIC/anon/authenticated EXECUTE. Remove them atomically.
REVOKE ALL ON FUNCTION public.consume_tmdb_rate_limit(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_tmdb_rate_limit(uuid) TO service_role;
-- Removes our grant only; the bootstrap superuser's automatic ADMIN membership
-- remains, with SET/INHERIT false. Never try to revoke Supabase-managed grants.
REVOKE tmdb_rate_limiter_owner FROM postgres;

-- To adjust limits later, an administrator updates ONLY the singleton settings
-- row. No caller can supply limits or a clock. Expired events are pruned on use;
-- no scheduler, movie foreign keys, triggers or changes to existing RPCs needed.
NOTIFY pgrst, 'reload schema';
COMMIT;
