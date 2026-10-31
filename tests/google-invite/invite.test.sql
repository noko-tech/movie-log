-- Run ONLY through run.py in its newly initialized offline cluster.
-- Every address is reserved example.invalid data; all changes roll back.
BEGIN;
CREATE FUNCTION pg_temp.check(label text, ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %', label; END IF;
  RAISE NOTICE 'PASS %', label;
END $$;
CREATE FUNCTION pg_temp.event(email text DEFAULT 'invited@example.invalid') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'metadata', jsonb_build_object(
      'uuid', '00000000-0000-4000-8000-000000000099',
      'time', '2026-10-31T00:00:00Z', 'name', 'before-user-created', 'ip_address', '127.0.0.1'
    ),
    'user', jsonb_build_object(
      'id', '00000000-0000-4000-8000-000000000002',
      'aud', 'authenticated', 'role', '', 'email', email, 'phone', '',
      'app_metadata', jsonb_build_object('provider', 'google', 'providers', jsonb_build_array('google')),
      'user_metadata', '{}'::jsonb, 'identities', '[]'::jsonb,
      'created_at', '0001-01-01T00:00:00Z', 'updated_at', '0001-01-01T00:00:00Z',
      'is_anonymous', false
    )
  );
$$;
CREATE FUNCTION pg_temp.denied(event jsonb) RETURNS boolean
LANGUAGE sql AS $$
  SELECT google_invite_private.before_user_created(event) =
    '{"error":{"http_code":403,"message":"新規登録は現在許可されていません。"}}'::jsonb;
$$;
DO $$ DECLARE temp_schema text; BEGIN
  SELECT nspname INTO temp_schema FROM pg_namespace WHERE oid=pg_my_temp_schema();
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO supabase_auth_admin, anon, authenticated, service_role', temp_schema);
END $$;

SELECT pg_temp.check('hook is invoker with empty search_path',
  (SELECT NOT prosecdef AND proconfig = ARRAY['search_path=""']
    FROM pg_proc WHERE oid='google_invite_private.before_user_created(jsonb)'::regprocedure));
SELECT pg_temp.check('only new private schema contains new tables and hook',
  (SELECT count(*)=2 FROM pg_tables WHERE schemaname='google_invite_private')
  AND (SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='google_invite_private'));
SELECT pg_temp.check('default mode is invite_only and allowlist is empty',
  (SELECT mode='invite_only' FROM google_invite_private.signup_policy)
  AND NOT EXISTS (SELECT 1 FROM google_invite_private.invitations));
SELECT pg_temp.check('invitation table has no user foreign key or expiry',
  NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='google_invite_private.invitations'::regclass AND contype='f')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='google_invite_private' AND table_name='invitations'
      AND column_name LIKE '%expir%'));

SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('empty allowlist rejects Google signup', pg_temp.denied(pg_temp.event()));
RESET ROLE;

-- Administrator operations; no user creation or identity changes.
SET LOCAL ROLE postgres;
INSERT INTO google_invite_private.invitations (email, created_at)
VALUES (lower(btrim('  INVITED@EXAMPLE.INVALID  ')), '2000-01-01T00:00:00Z');
INSERT INTO google_invite_private.invitations (email) VALUES
  ('workspace@example.invalid'), ('alias+one@example.invalid'), ('dot.name@example.invalid');
RESET ROLE;

SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('invited Google returns official empty success object',
  google_invite_private.before_user_created(pg_temp.event()) = '{}'::jsonb);
SELECT pg_temp.check('case and outside spaces normalize',
  google_invite_private.before_user_created(pg_temp.event('  INVITED@EXAMPLE.INVALID  ')) = '{}'::jsonb);
SELECT pg_temp.check('no expiration even for old invitation',
  google_invite_private.before_user_created(pg_temp.event()) = '{}'::jsonb);
SELECT pg_temp.check('Google account does not require gmail.com',
  google_invite_private.before_user_created(pg_temp.event('workspace@example.invalid')) = '{}'::jsonb);
SELECT pg_temp.check('uninvited Google rejects with identical generic message',
  pg_temp.denied(pg_temp.event('outsider@example.invalid')));
SELECT pg_temp.check('plus aliases are not merged', pg_temp.denied(pg_temp.event('alias@example.invalid')));
SELECT pg_temp.check('dots are not removed', pg_temp.denied(pg_temp.event('dotname@example.invalid')));
SELECT pg_temp.check('untrusted user_metadata cannot change authoritative email',
  pg_temp.denied(jsonb_set(pg_temp.event('outsider@example.invalid'), '{user,user_metadata}',
    '{"email":"invited@example.invalid","provider":"google","email_verified":true,"is_invited":true}')));
SELECT pg_temp.check('irrelevant user_metadata cannot break valid signup',
  google_invite_private.before_user_created(jsonb_set(pg_temp.event(), '{user,user_metadata}',
    '{"email":"outsider@example.invalid","provider":"email","email_verified":false}')) = '{}'::jsonb);

DO $cases$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('SQL null event', NULL::jsonb),
    ('JSON null event', 'null'::jsonb),
    ('array event', '[]'::jsonb),
    ('string event', '"google"'::jsonb),
    ('empty object event', '{}'::jsonb),
    ('missing request metadata', pg_temp.event() - 'metadata'),
    ('invalid metadata type', jsonb_set(pg_temp.event(), '{metadata}', '[]')),
    ('wrong hook name', jsonb_set(pg_temp.event(), '{metadata,name}', '"custom-access-token"')),
    ('missing user', pg_temp.event() - 'user'),
    ('invalid user type', jsonb_set(pg_temp.event(), '{user}', '[]')),
    ('missing id', pg_temp.event() #- '{user,id}'),
    ('invalid id', jsonb_set(pg_temp.event(), '{user,id}', '"not-a-uuid"')),
    ('missing email', pg_temp.event() #- '{user,email}'),
    ('null email', jsonb_set(pg_temp.event(), '{user,email}', 'null')),
    ('object email', jsonb_set(pg_temp.event(), '{user,email}', '{}')),
    ('empty email', pg_temp.event('')),
    ('whitespace email', pg_temp.event('   ')),
    ('missing at email', pg_temp.event('invalid.example.invalid')),
    ('two at email', pg_temp.event('invalid@@example.invalid')),
    ('inner whitespace email', pg_temp.event('in vited@example.invalid')),
    ('newline email', pg_temp.event(E'invited@example.invalid\n')),
    ('too long email', pg_temp.event(repeat('x', 254) || '@example.invalid')),
    ('missing app_metadata', pg_temp.event() #- '{user,app_metadata}'),
    ('invalid app_metadata type', jsonb_set(pg_temp.event(), '{user,app_metadata}', '[]')),
    ('missing provider', pg_temp.event() #- '{user,app_metadata,provider}'),
    ('null provider', jsonb_set(pg_temp.event(), '{user,app_metadata,provider}', 'null')),
    ('wrong provider type', jsonb_set(pg_temp.event(), '{user,app_metadata,provider}', '["google"]')),
    ('email password provider', jsonb_set(pg_temp.event(), '{user,app_metadata}',
      '{"provider":"email","providers":["email"]}')),
    ('another OAuth provider', jsonb_set(pg_temp.event(), '{user,app_metadata}',
      '{"provider":"github","providers":["github"]}')),
    ('missing providers', pg_temp.event() #- '{user,app_metadata,providers}'),
    ('wrong providers type', jsonb_set(pg_temp.event(), '{user,app_metadata,providers}', '"google"')),
    ('conflicting providers', jsonb_set(pg_temp.event(), '{user,app_metadata,providers}', '["email"]')),
    ('multiple providers on new user', jsonb_set(pg_temp.event(), '{user,app_metadata,providers}', '["google","email"]')),
    ('anonymous user', jsonb_set(pg_temp.event(), '{user,is_anonymous}', 'true')),
    ('missing anonymous flag', pg_temp.event() #- '{user,is_anonymous}'),
    ('string anonymous flag', jsonb_set(pg_temp.event(), '{user,is_anonymous}', '"false"')),
    ('spoofed Google via user_metadata', jsonb_set(
      jsonb_set(pg_temp.event(), '{user,app_metadata}', '{"provider":"email","providers":["email"]}'),
      '{user,user_metadata}', '{"provider":"google","providers":["google"],"email_verified":true}'))
  ) AS cases(label, event)
  LOOP
    PERFORM pg_temp.check(item.label || ' rejected', pg_temp.denied(item.event));
  END LOOP;
END $cases$;
RESET ROLE;

SET LOCAL ROLE postgres;
UPDATE google_invite_private.invitations SET active=false, updated_at=now()
WHERE email='invited@example.invalid';
RESET ROLE;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('deactivated invitation rejects new signup', pg_temp.denied(pg_temp.event()));
RESET ROLE;
SET LOCAL ROLE postgres;
INSERT INTO google_invite_private.invitations (email, active)
VALUES ('invited@example.invalid', true)
ON CONFLICT (email) DO UPDATE SET active=EXCLUDED.active, updated_at=now();
RESET ROLE;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('admin can reactivate through upsert',
  google_invite_private.before_user_created(pg_temp.event()) = '{}'::jsonb);
SELECT pg_temp.check('successful signup check does not consume invitation',
  google_invite_private.before_user_created(pg_temp.event()) = '{}'::jsonb
  AND (SELECT active FROM google_invite_private.invitations WHERE email='invited@example.invalid'));
RESET ROLE;

SET LOCAL ROLE postgres;
INSERT INTO google_invite_private.invitations(email) VALUES ('existing@example.invalid');
UPDATE google_invite_private.invitations SET active=false, updated_at=now()
WHERE email='existing@example.invalid';
RESET ROLE;
SELECT pg_temp.check('deactivating existing synthetic user invite preserves user and movies',
  preservation_fixture.snapshot() = (SELECT value FROM preservation_fixture.baseline));

DO $acl$
DECLARE role_name text; statement text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    PERFORM pg_temp.check(role_name || ' has no schema/table/function privileges',
      NOT has_schema_privilege(role_name, 'google_invite_private', 'USAGE')
      AND NOT has_schema_privilege(role_name, 'google_invite_private', 'CREATE')
      AND NOT has_function_privilege(role_name, 'google_invite_private.before_user_created(jsonb)', 'EXECUTE')
      AND NOT has_table_privilege(role_name, 'google_invite_private.invitations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege(role_name, 'google_invite_private.signup_policy', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    FOREACH statement IN ARRAY ARRAY[
      'SELECT google_invite_private.before_user_created(''{}''::jsonb)',
      'SELECT * FROM google_invite_private.invitations',
      'INSERT INTO google_invite_private.invitations(email) VALUES (''forbidden@example.invalid'')',
      'UPDATE google_invite_private.invitations SET active=false',
      'DELETE FROM google_invite_private.invitations',
      'TRUNCATE google_invite_private.invitations',
      'SELECT * FROM google_invite_private.signup_policy',
      'UPDATE google_invite_private.signup_policy SET mode=''public_google'''
    ] LOOP
      BEGIN
        EXECUTE statement;
        RAISE EXCEPTION 'unexpected permission for %', role_name;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    RESET ROLE;
    PERFORM pg_temp.check(role_name || ' actual direct access rejected', true);
  END LOOP;
END $acl$;

SET LOCAL ROLE supabase_auth_admin;
DO $auth_acl$
DECLARE statement text;
BEGIN
  FOREACH statement IN ARRAY ARRAY[
    'INSERT INTO google_invite_private.invitations(email) VALUES (''forbidden@example.invalid'')',
    'UPDATE google_invite_private.invitations SET active=false',
    'DELETE FROM google_invite_private.invitations',
    'TRUNCATE google_invite_private.invitations',
    'UPDATE google_invite_private.signup_policy SET mode=''public_google''',
    'CREATE TABLE google_invite_private.forbidden(id integer)'
  ] LOOP
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'Auth role unexpectedly has write permission';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  PERFORM pg_temp.check('Auth role cannot write tables or create schema objects', true);
END $auth_acl$;
RESET ROLE;

-- RLS still protects both tables even if table/schema ACLs are granted by mistake.
SAVEPOINT accidental_grant;
GRANT USAGE ON SCHEMA google_invite_private TO authenticated;
GRANT ALL ON google_invite_private.invitations, google_invite_private.signup_policy TO authenticated;
SET LOCAL ROLE authenticated;
SELECT pg_temp.check('RLS hides invitations after accidental table grant',
  NOT EXISTS (SELECT 1 FROM google_invite_private.invitations));
SELECT pg_temp.check('RLS hides policy after accidental table grant',
  NOT EXISTS (SELECT 1 FROM google_invite_private.signup_policy));
DO $$ BEGIN
  BEGIN
    INSERT INTO google_invite_private.invitations(email) VALUES ('forbidden@example.invalid');
    RAISE EXCEPTION 'RLS insert bypass';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM pg_temp.check('RLS prevents invitation insertion', true);
END $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT accidental_grant;

-- Inject operational failures; every failure must give the same denial.
SAVEPOINT fault;
REVOKE EXECUTE ON FUNCTION google_invite_private.before_user_created(jsonb) FROM supabase_auth_admin;
SET LOCAL ROLE supabase_auth_admin;
DO $$ BEGIN
  BEGIN
    PERFORM google_invite_private.before_user_created(pg_temp.event());
    RAISE EXCEPTION 'Hook ran without EXECUTE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM pg_temp.check('missing Hook EXECUTE prevents invocation', true);
END $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT fault;
REVOKE USAGE ON SCHEMA google_invite_private FROM supabase_auth_admin;
SET LOCAL ROLE supabase_auth_admin;
DO $$ BEGIN
  BEGIN
    PERFORM google_invite_private.before_user_created(pg_temp.event());
    RAISE EXCEPTION 'Hook ran without schema USAGE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM pg_temp.check('missing schema USAGE prevents Hook invocation', true);
END $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT fault;
REVOKE SELECT ON google_invite_private.invitations FROM supabase_auth_admin;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('missing invitation SELECT grant fails closed without SQL detail', pg_temp.denied(pg_temp.event()));
RESET ROLE;
ROLLBACK TO SAVEPOINT fault;
REVOKE SELECT ON google_invite_private.signup_policy FROM supabase_auth_admin;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('missing policy SELECT grant fails closed', pg_temp.denied(pg_temp.event()));
RESET ROLE;
ROLLBACK TO SAVEPOINT fault;
DROP POLICY auth_hook_read_invitations ON google_invite_private.invitations;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('missing invitation RLS policy fails closed', pg_temp.denied(pg_temp.event()));
RESET ROLE;
ROLLBACK TO SAVEPOINT fault;
DROP POLICY auth_hook_read_signup_policy ON google_invite_private.signup_policy;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('missing settings RLS policy fails closed', pg_temp.denied(pg_temp.event()));
RESET ROLE;
ROLLBACK TO SAVEPOINT fault;
DELETE FROM google_invite_private.signup_policy;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('missing settings row fails closed', pg_temp.denied(pg_temp.event()));
RESET ROLE;
ROLLBACK TO SAVEPOINT fault;
ALTER TABLE google_invite_private.invitations RENAME TO unavailable_invitations;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('internal table lookup error fails closed', pg_temp.denied(pg_temp.event()));
RESET ROLE;
ROLLBACK TO SAVEPOINT fault;

-- Constraint checks and duplicate normalization, under administrator privileges.
SET LOCAL ROLE postgres;
DO $constraints$
DECLARE address text;
BEGIN
  FOREACH address IN ARRAY ARRAY['bad','UPPER@example.invalid',' leading@example.invalid','two@@example.invalid'] LOOP
    BEGIN
      INSERT INTO google_invite_private.invitations(email) VALUES (address);
      RAISE EXCEPTION 'invalid invite accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  PERFORM pg_temp.check('database rejects non-normalized or malformed invitation emails', true);
  BEGIN
    INSERT INTO google_invite_private.invitations(email)
    VALUES (lower(btrim(' INVITED@EXAMPLE.INVALID ')));
    RAISE EXCEPTION 'duplicate invite accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  PERFORM pg_temp.check('normalized duplicate invitation rejected', true);
  BEGIN
    INSERT INTO google_invite_private.signup_policy(singleton,mode) VALUES(false,'public_google');
    RAISE EXCEPTION 'second settings row accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM pg_temp.check('singleton policy enforced', true);
  BEGIN
    UPDATE google_invite_private.signup_policy SET mode='anything';
    RAISE EXCEPTION 'unknown mode accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM pg_temp.check('unknown policy mode rejected', true);
END $constraints$;
UPDATE google_invite_private.signup_policy SET mode='public_google', updated_at=now();
RESET ROLE;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('public_google admits uninvited Google only after admin switch',
  google_invite_private.before_user_created(pg_temp.event('outsider@example.invalid')) = '{}'::jsonb);
SELECT pg_temp.check('public_google still rejects email password', pg_temp.denied(
  jsonb_set(pg_temp.event(), '{user,app_metadata}', '{"provider":"email","providers":["email"]}')));
SELECT pg_temp.check('public_google still rejects missing email', pg_temp.denied(pg_temp.event() #- '{user,email}'));
SELECT pg_temp.check('public_google still rejects invalid requests', pg_temp.denied('{}'));
RESET ROLE;
SET LOCAL ROLE postgres;
UPDATE google_invite_private.signup_policy SET mode='closed', updated_at=now();
RESET ROLE;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('closed rejects even invited Google', pg_temp.denied(pg_temp.event()));
RESET ROLE;
SET LOCAL ROLE postgres;
UPDATE google_invite_private.signup_policy SET mode='invite_only', updated_at=now();
RESET ROLE;
SET LOCAL ROLE supabase_auth_admin;
SELECT pg_temp.check('returning to invite_only restores restrictions', pg_temp.denied(pg_temp.event('outsider@example.invalid')));
RESET ROLE;

SELECT pg_temp.check('synthetic user IDs, movies, RLS, RPC, ACL, triggers preserved',
  preservation_fixture.snapshot() = (SELECT value FROM preservation_fixture.baseline));
ROLLBACK;
