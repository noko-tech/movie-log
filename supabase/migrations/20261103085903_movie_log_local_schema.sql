
  create table "public"."movie_logs" (
    "id" uuid not null default gen_random_uuid(),
    "created_at" timestamp with time zone not null default now(),
    "user_id" uuid not null,
    "legacy_local_id" text,
    "tmdb_id" bigint,
    "media_type" text,
    "title" text not null,
    "poster_url" text,
    "overview" text,
    "rating" smallint not null default 0,
    "favorite" boolean not null default false,
    "status" text not null default 'watched'::text,
    "genre" text,
    "year" smallint,
    "runtime" smallint,
    "country" text,
    "director" text,
    "writer" text,
    "cast" text,
    "watch_date" text,
    "comment" text,
    "series_name" text,
    "series_order" smallint,
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."movie_logs" enable row level security;

CREATE UNIQUE INDEX movie_logs_pkey ON public.movie_logs USING btree (id);

CREATE UNIQUE INDEX movie_logs_user_legacy_local_id_key ON public.movie_logs USING btree (user_id, legacy_local_id);

alter table "public"."movie_logs" add constraint "movie_logs_pkey" PRIMARY KEY using index "movie_logs_pkey";

alter table "public"."movie_logs" add constraint "movie_logs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;

alter table "public"."movie_logs" validate constraint "movie_logs_user_id_fkey";

alter table "public"."movie_logs" add constraint "movie_logs_user_legacy_local_id_key" UNIQUE using index "movie_logs_user_legacy_local_id_key";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_movie_log_with_series_order(p_legacy_local_id text, p_title text, p_created_at timestamp with time zone, p_tmdb_id bigint DEFAULT NULL::bigint, p_media_type text DEFAULT 'movie'::text, p_poster_url text DEFAULT NULL::text, p_overview text DEFAULT NULL::text, p_rating smallint DEFAULT 0, p_favorite boolean DEFAULT false, p_status text DEFAULT 'watched'::text, p_genre text DEFAULT NULL::text, p_year smallint DEFAULT NULL::smallint, p_runtime smallint DEFAULT NULL::smallint, p_country text DEFAULT NULL::text, p_director text DEFAULT NULL::text, p_writer text DEFAULT NULL::text, p_cast text DEFAULT NULL::text, p_watch_date text DEFAULT NULL::text, p_comment text DEFAULT NULL::text, p_series_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_new_id uuid;
  v_series_name text;
  v_series_count bigint;
  v_movie public.movie_logs%ROWTYPE;
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

  IF pg_catalog.current_setting('transaction_isolation')
       <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '25000',
      MESSAGE = 'MOVIE_LOG_ISOLATION_UNSUPPORTED';
  END IF;

  IF p_legacy_local_id IS NULL
     OR pg_catalog.btrim(p_legacy_local_id, v_trim_chars) = ''
     OR p_title IS NULL
     OR pg_catalog.btrim(p_title, v_trim_chars) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MOVIE_LOG_REQUIRED_FIELD_INVALID';
  END IF;

  IF p_created_at IS NULL
     OR NOT pg_catalog.isfinite(p_created_at) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MOVIE_LOG_CREATED_AT_INVALID';
  END IF;

  IF p_rating IS NULL
     OR p_rating < 0
     OR p_rating > 5
     OR p_favorite IS NULL
     OR p_status IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MOVIE_LOG_VALUE_INVALID';
  END IF;

  IF p_tmdb_id IS NOT NULL
     AND (
       p_tmdb_id < -9007199254740991
       OR p_tmdb_id > 9007199254740991
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MOVIE_LOG_TMDB_ID_INVALID';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'movie-log:create:' || v_user_id::text,
      0::bigint
    )
  );

  v_series_name := pg_catalog.btrim(
    COALESCE(p_series_name, ''),
    v_trim_chars
  );

  INSERT INTO public.movie_logs (
    user_id,
    legacy_local_id,
    created_at,
    tmdb_id,
    media_type,
    title,
    poster_url,
    overview,
    rating,
    favorite,
    status,
    genre,
    year,
    runtime,
    country,
    director,
    writer,
    "cast",
    watch_date,
    comment,
    series_name,
    series_order
  )
  VALUES (
    v_user_id,
    p_legacy_local_id,
    p_created_at,
    p_tmdb_id,
    p_media_type,
    p_title,
    p_poster_url,
    p_overview,
    p_rating,
    p_favorite,
    p_status,
    p_genre,
    p_year,
    p_runtime,
    p_country,
    p_director,
    p_writer,
    p_cast,
    p_watch_date,
    p_comment,
    p_series_name,
    NULL
  )
  RETURNING id INTO v_new_id;

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
        pg_catalog.row_number() OVER (
          ORDER BY
            m.year ASC,
            CASE
              WHEN m.series_order > 0
                THEN m.series_order::integer
              ELSE 32768
            END ASC,
            CASE WHEN m.id = v_new_id THEN 0 ELSE 1 END ASC,
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
    SELECT COALESCE(
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
    )
    INTO v_series_changes
    FROM updated AS u;

  END IF;

  SELECT m.*
  INTO STRICT v_movie
  FROM public.movie_logs AS m
  WHERE m.id = v_new_id
    AND m.user_id = v_user_id;

  RETURN pg_catalog.jsonb_build_object(
    'movie', pg_catalog.to_jsonb(v_movie),
    'series_changes', v_series_changes
  );

END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_movie_logs_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_movie_log_with_series_order(p_movie_id uuid, p_expected_legacy_local_id text, p_expected_updated_at timestamp with time zone, p_title text, p_tmdb_id bigint, p_media_type text, p_poster_url text, p_overview text, p_rating smallint, p_favorite boolean, p_status text, p_genre text, p_year smallint, p_runtime smallint, p_country text, p_director text, p_writer text, p_cast text, p_watch_date text, p_comment text, p_series_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_target public.movie_logs%ROWTYPE;
  v_movie public.movie_logs%ROWTYPE;
  v_updated_id uuid;
  v_old_series text;
  v_new_series text;
  v_series text;
  v_series_changed boolean;
  v_new_order_eligible boolean;
  v_series_count bigint;
  v_actual_changes bigint;
  v_expected_changes bigint;
  v_group_changes jsonb;
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
     OR pg_catalog.btrim(p_expected_legacy_local_id, v_trim_chars) = ''
     OR p_expected_updated_at IS NULL
     OR NOT pg_catalog.isfinite(p_expected_updated_at) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MOVIE_LOG_UPDATE_REFERENCE_INVALID';
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
        MESSAGE = 'MOVIE_LOG_UPDATE_IDENTITY_MISMATCH';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_found',
      'target_movie_id', p_movie_id,
      'target_legacy_local_id', p_expected_legacy_local_id,
      'movie', NULL::jsonb,
      'series_changes', '[]'::jsonb
    );
  END IF;

  IF v_target.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'target_movie_id', p_movie_id,
      'target_legacy_local_id', p_expected_legacy_local_id,
      'movie', NULL::jsonb,
      'series_changes', '[]'::jsonb
    );
  END IF;

  IF p_title IS NULL
     OR pg_catalog.btrim(p_title, v_trim_chars) = ''
     OR p_rating IS NULL
     OR p_rating < 0
     OR p_rating > 5
     OR p_favorite IS NULL
     OR p_status IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MOVIE_LOG_UPDATE_VALUE_INVALID';
  END IF;

  IF p_tmdb_id IS NOT NULL
     AND (
       p_tmdb_id < -9007199254740991
       OR p_tmdb_id > 9007199254740991
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MOVIE_LOG_TMDB_ID_INVALID';
  END IF;

  v_old_series := pg_catalog.btrim(
    COALESCE(v_target.series_name, ''),
    v_trim_chars
  );

  v_new_series := pg_catalog.btrim(
    COALESCE(p_series_name, ''),
    v_trim_chars
  );

  v_series_changed :=
    (v_old_series COLLATE "C")
      IS DISTINCT FROM (v_new_series COLLATE "C")
    OR v_target.year IS DISTINCT FROM p_year;

  v_new_order_eligible :=
    v_new_series <> ''
    AND p_year IS NOT NULL
    AND p_year BETWEEN 1000 AND 9999;

  UPDATE public.movie_logs AS m
  SET
    tmdb_id = p_tmdb_id,
    media_type = p_media_type,
    title = p_title,
    poster_url = p_poster_url,
    overview = p_overview,
    rating = p_rating,
    favorite = p_favorite,
    status = p_status,
    genre = p_genre,
    year = p_year,
    runtime = p_runtime,
    country = p_country,
    director = p_director,
    writer = p_writer,
    "cast" = p_cast,
    watch_date = p_watch_date,
    comment = p_comment,
    series_name = p_series_name,
    series_order = CASE
      WHEN v_series_changed AND NOT v_new_order_eligible THEN NULL
      ELSE v_target.series_order
    END
  WHERE m.user_id = v_user_id
    AND m.id = p_movie_id
    AND m.legacy_local_id = p_expected_legacy_local_id
    AND m.updated_at = p_expected_updated_at
  RETURNING m.id INTO v_updated_id;

  IF NOT FOUND OR v_updated_id IS DISTINCT FROM p_movie_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MOVIE_LOG_UPDATE_NOT_CONFIRMED';
  END IF;

  IF v_series_changed THEN

    FOR v_series IN
      SELECT DISTINCT names.name COLLATE "C"
      FROM pg_catalog.unnest(
        ARRAY[v_old_series, v_new_series]
      ) AS names(name)
      WHERE names.name <> ''
      ORDER BY names.name COLLATE "C"
    LOOP

      PERFORM m.id
      FROM public.movie_logs AS m
      WHERE m.user_id = v_user_id
        AND (
          pg_catalog.btrim(
            COALESCE(m.series_name, ''),
            v_trim_chars
          ) COLLATE "C"
        ) = (v_series COLLATE "C")
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
        ) = (v_series COLLATE "C")
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
          ) = (v_series COLLATE "C")
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
          ) FILTER (WHERE u.id <> p_movie_id),
          '[]'::jsonb
        ),
        pg_catalog.count(u.id),
        (
          SELECT pg_catalog.count(*)
          FROM ranked AS r
          WHERE r.old_order IS DISTINCT FROM r.new_order::smallint
        )
      INTO
        v_group_changes,
        v_actual_changes,
        v_expected_changes
      FROM updated AS u;

      IF v_actual_changes <> v_expected_changes THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MOVIE_LOG_SERIES_UPDATE_NOT_CONFIRMED';
      END IF;

      v_series_changes := v_series_changes || v_group_changes;

    END LOOP;
  END IF;

  SELECT m.*
  INTO STRICT v_movie
  FROM public.movie_logs AS m
  WHERE m.user_id = v_user_id
    AND m.id = p_movie_id
    AND m.legacy_local_id = p_expected_legacy_local_id;

  IF v_target.series_order IS DISTINCT FROM v_movie.series_order THEN
    v_series_changes := v_series_changes
      || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'id', v_movie.id,
          'legacy_local_id', v_movie.legacy_local_id,
          'series_order', v_movie.series_order,
          'updated_at', v_movie.updated_at
        )
      );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'updated',
    'target_movie_id', p_movie_id,
    'target_legacy_local_id', p_expected_legacy_local_id,
    'movie', pg_catalog.to_jsonb(v_movie),
    'series_changes', v_series_changes
  );

END;
$function$
;

grant delete on table "public"."movie_logs" to "authenticated";

grant insert on table "public"."movie_logs" to "authenticated";

grant select on table "public"."movie_logs" to "authenticated";

grant update on table "public"."movie_logs" to "authenticated";

grant delete on table "public"."movie_logs" to "service_role";

grant insert on table "public"."movie_logs" to "service_role";

grant references on table "public"."movie_logs" to "service_role";

grant select on table "public"."movie_logs" to "service_role";

grant trigger on table "public"."movie_logs" to "service_role";

grant truncate on table "public"."movie_logs" to "service_role";

grant update on table "public"."movie_logs" to "service_role";


  create policy "Users can delete own movie logs"
  on "public"."movie_logs"
  as permissive
  for delete
  to authenticated
using ((( SELECT auth.uid() AS uid) = user_id));



  create policy "Users can insert own movie logs"
  on "public"."movie_logs"
  as permissive
  for insert
  to authenticated
with check ((( SELECT auth.uid() AS uid) = user_id));



  create policy "Users can read own movie logs"
  on "public"."movie_logs"
  as permissive
  for select
  to authenticated
using ((( SELECT auth.uid() AS uid) = user_id));



  create policy "Users can update own movie logs"
  on "public"."movie_logs"
  as permissive
  for update
  to authenticated
using ((( SELECT auth.uid() AS uid) = user_id))
with check ((( SELECT auth.uid() AS uid) = user_id));


CREATE TRIGGER set_movie_logs_updated_at BEFORE UPDATE ON public.movie_logs FOR EACH ROW EXECUTE FUNCTION public.set_movie_logs_updated_at();