-- Creates objects only. This does NOT enable a Supabase Auth Hook or Google.
-- Apply as postgres, or a migration session allowed to SET ROLE postgres.
BEGIN;
SET LOCAL ROLE postgres;

-- No IF NOT EXISTS / CREATE OR REPLACE: an unexpected name collision must stop
-- the entire migration instead of silently trusting an existing object.
CREATE SCHEMA google_invite_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA google_invite_private
  FROM PUBLIC, anon, authenticated, service_role, supabase_auth_admin;
GRANT USAGE ON SCHEMA google_invite_private TO supabase_auth_admin;

CREATE TABLE google_invite_private.invitations (
  email text PRIMARY KEY,
  provider text NOT NULL DEFAULT 'google' CHECK (provider = 'google'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT normalized_invitation_email CHECK (
    email = lower(btrim(email))
    AND length(email) BETWEEN 3 AND 254
    AND email ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+[.][^@[:space:][:cntrl:]]+$'
  )
);

-- A single administrator-controlled switch. No setting / no permission means
-- deny, never "public". public_google still requires a valid Google signup.
CREATE TABLE google_invite_private.signup_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL CHECK (mode IN ('invite_only', 'public_google', 'closed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO google_invite_private.signup_policy (singleton, mode)
VALUES (true, 'invite_only');

-- Supabase installations can have permissive default privileges. Revoke them
-- explicitly on every new object; do not change defaults for existing schemas.
REVOKE ALL ON TABLE google_invite_private.invitations,
  google_invite_private.signup_policy
  FROM PUBLIC, anon, authenticated, service_role, supabase_auth_admin;
GRANT SELECT ON TABLE google_invite_private.invitations,
  google_invite_private.signup_policy TO supabase_auth_admin;

ALTER TABLE google_invite_private.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_invite_private.signup_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_hook_read_invitations
  ON google_invite_private.invitations FOR SELECT
  TO supabase_auth_admin USING (true);
CREATE POLICY auth_hook_read_signup_policy
  ON google_invite_private.signup_policy FOR SELECT
  TO supabase_auth_admin USING (true);

CREATE FUNCTION google_invite_private.before_user_created(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $hook$
DECLARE
  denial CONSTANT jsonb := '{"error":{"http_code":403,"message":"新規登録は現在許可されていません。"}}'::jsonb;
  signup_email text;
  signup_mode text;
BEGIN
  -- Validate the security-relevant parts of the official hook event. Use
  -- IS DISTINCT FROM so missing keys / JSON null cannot bypass a condition.
  IF jsonb_typeof(event) IS DISTINCT FROM 'object'
    OR jsonb_typeof(event -> 'metadata') IS DISTINCT FROM 'object'
    OR event #>> '{metadata,name}' IS DISTINCT FROM 'before-user-created'
    OR jsonb_typeof(event -> 'user') IS DISTINCT FROM 'object'
    OR jsonb_typeof(event #> '{user,id}') IS DISTINCT FROM 'string'
    OR (event #>> '{user,id}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(event #> '{user,email}') IS DISTINCT FROM 'string'
    OR event #> '{user,is_anonymous}' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(event #> '{user,app_metadata}') IS DISTINCT FROM 'object'
    OR event #> '{user,app_metadata,provider}' IS DISTINCT FROM '"google"'::jsonb
    OR event #> '{user,app_metadata,providers}' IS DISTINCT FROM '["google"]'::jsonb
  THEN
    RETURN denial;
  END IF;

  -- Auth supplies user.email and app_metadata after validating the provider.
  -- Never use user_metadata, a client-supplied provider, or a gmail.com suffix
  -- as proof of identity. Google Workspace / other Google emails also work.
  signup_email := lower(btrim(event #>> '{user,email}'));
  IF length(signup_email) NOT BETWEEN 3 AND 254
    OR signup_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+[.][^@[:space:][:cntrl:]]+$'
  THEN
    RETURN denial;
  END IF;

  SELECT mode INTO STRICT signup_mode
    FROM google_invite_private.signup_policy WHERE singleton;

  IF signup_mode = 'public_google' THEN
    RETURN '{}'::jsonb;
  ELSIF signup_mode = 'invite_only' AND EXISTS (
    SELECT 1 FROM google_invite_private.invitations
      WHERE email = signup_email AND provider = 'google' AND active
  ) THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN denial;
EXCEPTION
  -- Missing grants, missing settings, broken objects, etc. must fail closed.
  -- Do not return SQLERRM, event contents, addresses, or invitation state.
  -- Timeouts / cancellation outside OTHERS also abort creation at Auth level.
  WHEN OTHERS THEN
    RETURN denial;
END;
$hook$;

REVOKE ALL ON FUNCTION google_invite_private.before_user_created(jsonb)
  FROM PUBLIC, anon, authenticated, service_role, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION google_invite_private.before_user_created(jsonb)
  TO supabase_auth_admin;

COMMENT ON SCHEMA google_invite_private IS
  'Private Google signup allowlist. Never expose through the Data API.';
COMMENT ON FUNCTION google_invite_private.before_user_created(jsonb) IS
  'Before User Created hook; no login checks or user/data writes. Explicit Auth configuration required.';
COMMIT;
