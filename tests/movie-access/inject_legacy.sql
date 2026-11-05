-- Only upgrade patterns inject these intentionally unsafe legacy attributes.
SET ROLE postgres;
GRANT ALL ON TABLE public.movie_logs TO PUBLIC;
GRANT ALL ON TABLE public.movie_logs TO authenticated WITH GRANT OPTION;
GRANT SELECT(title) ON public.movie_logs TO anon;
GRANT REFERENCES(title) ON public.movie_logs TO authenticated;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'create_movie_log_with_series_order', 'update_movie_log_with_series_order',
      'delete_movie_log_with_series_order')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', item.signature);
  END LOOP;
END;
$$;
RESET ROLE;
