-- ────────────────────────────────────────────────────────────────────────────
-- 023: Google Workspace Directory integration
--
-- Adds the google_directory integration for looking up organization members
-- via the Google People API (directory.readonly scope). Works for any Google
-- Workspace user — no admin privileges needed.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest)
VALUES (
  'google_directory',
  'Google',
  'Google Workspace Directory',
  'Look up team members by name — enables Slack DMs, email lookups, and org chart awareness.',
  'oauth2',
  'content_management',
  13,
  '{
    "oauth_authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
    "oauth_token_url": "https://oauth2.googleapis.com/token",
    "default_scopes": ["https://www.googleapis.com/auth/directory.readonly", "email", "profile"],
    "client_id_env_key": "GOOGLE_CLIENT_ID",
    "client_secret_env_key": "GOOGLE_CLIENT_SECRET"
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO integration_permissions (integration_id, scope, display_name, description, is_mandatory)
SELECT id, 'directory.readonly', 'Read Directory', 'Search your organization directory for people by name', true
FROM integrations WHERE key = 'google_directory'
ON CONFLICT DO NOTHING;
