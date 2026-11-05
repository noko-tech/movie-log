-- Synthetic rows in this invocation's disposable cluster only.
-- In fresh cases this runs AFTER all five unmodified migrations.
INSERT INTO auth.users VALUES
  ('00000000-0000-4000-8000-000000000001', 'user-a@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'user-b@example.invalid');
INSERT INTO public.movie_logs
  (id, user_id, legacy_local_id, title, year, series_name, series_order, updated_at)
VALUES
  ('10000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000001', 'fixture-a', 'MOVIE_A',
   2020, 'SERIES', 1, '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000002', 'fixture-b', 'MOVIE_B',
   2020, 'SERIES', 1, '2026-01-01T00:00:00Z');
INSERT INTO google_invite_private.invitations(email) VALUES ('invited@example.invalid');
