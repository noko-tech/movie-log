CREATE OR REPLACE FUNCTION public.delete_movie_log_with_series_order(p_movie_id uuid, p_expected_legacy_local_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_target public.movie_logs%ROWTYPE;
  v_deleted_id uuid;
  v_deleted_legacy_local_id text;
  v_series_name text;
  v_series_count bigint;
  v_expected_changes bigint;
  v_actual_changes bigint;
  v_series_changes jsonb := '[]'::jsonb;

  v_trim_chars CONSTANT text :=
      pg_catalog.chr(9)
    || pg_catalog.chr(10)
    || pg_catalog.chr(11)
    || pg_catalog.chr(12)
    || pg_catalog.chr(13)
    || ' '
    || U&'\00A0\1680\2000\2001\2002\2003\2004\2005'
    || U&'\2006\2007\2008\2009\200A\2028\2029\202F'
    || U&'\205F\3000\FEFF';

BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'MOVIE_LOG_AUTH_REQUIRED';
  END IF;

  IF p_movie_id IS NULL
     OR p_expected_legacy_local_id IS NULL
     OR pg_catalog.btrim(
          p_expected_legacy_local_id,
          v_trim_chars
        ) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MOVIE_LOG_DELETE_ARGUMENT_INVALID';
  END IF;

  IF pg_catalog.current_setting('transaction_isolation')
       <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '25000',
      MESSAGE = 'MOVIE_LOG_ISOLATION_UNSUPPORTED';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'movie-log:create:' || v_user_id::text,
      0::bigint
    )
  );

  SELECT m.*
  INTO v_target
  FROM public.movie_logs AS m
  WHERE m.user_id = v_user_id
    AND m.id = p_movie_id
    AND m.legacy_local_id = p_expected_legacy_local_id
  FOR UPDATE OF m;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.movie_logs AS m
      WHERE m.user_id = v_user_id
        AND m.id = p_movie_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MOVIE_LOG_DELETE_IDENTITY_MISMATCH';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_found',
      'target_movie_id', p_movie_id,
      'target_legacy_local_id', p_expected_legacy_local_id,
      'deleted_movie_id', NULL::uuid,
      'deleted_legacy_local_id', NULL::text,
      'series_changes', '[]'::jsonb
    );
  END IF;

  v_series_name := pg_catalog.btrim(
    COALESCE(v_target.series_name, ''),
    v_trim_chars
  );

  DELETE FROM public.movie_logs AS m
  WHERE m.user_id = v_user_id
    AND m.id = p_movie_id
    AND m.legacy_local_id = p_expected_legacy_local_id
  RETURNING m.id, m.legacy_local_id
  INTO v_deleted_id, v_deleted_legacy_local_id;

  IF NOT FOUND
     OR v_deleted_id IS DISTINCT FROM p_movie_id
     OR v_deleted_legacy_local_id
          IS DISTINCT FROM p_expected_legacy_local_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MOVIE_LOG_DELETE_NOT_CONFIRMED';
  END IF;

  IF v_series_name <> '' THEN
    PERFORM m.id
    FROM public.movie_logs AS m
    WHERE m.user_id = v_user_id
      AND (
        pg_catalog.btrim(
          COALESCE(m.series_name, ''),
          v_trim_chars
        ) COLLATE "C"
      ) = (v_series_name COLLATE "C")
    ORDER BY m.id
    FOR UPDATE OF m;

    SELECT pg_catalog.count(*)
    INTO v_series_count
    FROM public.movie_logs AS m
    WHERE m.user_id = v_user_id
      AND (
        pg_catalog.btrim(
          COALESCE(m.series_name, ''),
          v_trim_chars
        ) COLLATE "C"
      ) = (v_series_name COLLATE "C")
      AND m.year BETWEEN 1000 AND 9999;

    IF v_series_count > 32767 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'MOVIE_LOG_SERIES_ORDER_OVERFLOW';
    END IF;

    WITH ranked AS (
      SELECT
        m.id,
        m.series_order AS old_order,
        pg_catalog.row_number() OVER (
          ORDER BY
            m.year ASC,
            CASE
              WHEN m.series_order > 0
                THEN m.series_order::integer
              ELSE 32768
            END ASC,
            m.id ASC
        ) AS new_order
      FROM public.movie_logs AS m
      WHERE m.user_id = v_user_id
        AND (
          pg_catalog.btrim(
            COALESCE(m.series_name, ''),
            v_trim_chars
          ) COLLATE "C"
        ) = (v_series_name COLLATE "C")
        AND m.year BETWEEN 1000 AND 9999
    ),
    updated AS (
      UPDATE public.movie_logs AS m
      SET series_order = r.new_order::smallint
      FROM ranked AS r
      WHERE m.id = r.id
        AND m.user_id = v_user_id
        AND m.series_order IS DISTINCT FROM r.new_order::smallint
      RETURNING
        m.id,
        m.legacy_local_id,
        m.series_order,
        m.updated_at
    )
    SELECT
      COALESCE(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', u.id,
            'legacy_local_id', u.legacy_local_id,
            'series_order', u.series_order,
            'updated_at', u.updated_at
          )
          ORDER BY u.series_order, u.id
        ),
        '[]'::jsonb
      ),
      pg_catalog.count(u.id),
      (
        SELECT pg_catalog.count(*)
        FROM ranked AS r
        WHERE r.old_order IS DISTINCT FROM r.new_order::smallint
      )
    INTO
      v_series_changes,
      v_actual_changes,
      v_expected_changes
    FROM updated AS u;

    IF v_actual_changes <> v_expected_changes THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MOVIE_LOG_SERIES_UPDATE_NOT_CONFIRMED';
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'deleted',
    'target_movie_id', p_movie_id,
    'target_legacy_local_id', p_expected_legacy_local_id,
    'deleted_movie_id', v_deleted_id,
    'deleted_legacy_local_id', v_deleted_legacy_local_id,
    'series_changes', v_series_changes
  );

END;
$function$;
