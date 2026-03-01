-- Migration 005: Fix OAuth scopes in integration catalog
--
-- Problem: DB manifest.default_scopes was taking precedence over provider code,
-- and the seed data had wrong scopes (calendar.readonly is RESTRICTED, not SENSITIVE).
--
-- Fix: Update manifest scopes to match what the provider code requests.
-- The oauth-url route is also updated to always use provider.getDefaultScopes()
-- so these DB values are now metadata-only, but we fix them for consistency.

-- ── Google Calendar ────────────────────────────────────────────────────────
-- calendar.readonly is RESTRICTED (requires Google app verification for prod)
-- calendar.events is SENSITIVE — full read+write event management, no verification needed
UPDATE integrations
SET manifest = manifest || '{"default_scopes": ["https://www.googleapis.com/auth/calendar.events", "email", "profile"]}'::jsonb
WHERE key = 'google_calendar';

-- Fix the integration_permissions entry to match
UPDATE integration_permissions
SET scope = 'calendar.events',
    display_name = 'Manage Calendar Events',
    description = 'Read, create, edit, and delete calendar events'
WHERE scope = 'calendar.readonly'
  AND integration_id = (SELECT id FROM integrations WHERE key = 'google_calendar');

-- ── Gmail ──────────────────────────────────────────────────────────────────
-- Add email and profile scopes (needed for userinfo endpoint in handleCallback)
UPDATE integrations
SET manifest = manifest || '{"default_scopes": ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "email", "profile"]}'::jsonb
WHERE key = 'gmail';

-- ── Microsoft 365 (parent row) ────────────────────────────────────────────
-- Split into product-specific scopes — Mail+User only (Calendar and Teams are
-- separate integrations with their own rows and their own providers)
UPDATE integrations
SET manifest = manifest || '{"default_scopes": ["Mail.Read", "Mail.Send", "User.Read", "offline_access"]}'::jsonb
WHERE key = 'microsoft_365';

-- ── Outlook (child row — may not have a manifest yet) ─────────────────────
UPDATE integrations
SET manifest = COALESCE(manifest, '{}'::jsonb) || '{"default_scopes": ["Mail.Read", "Mail.Send", "User.Read", "offline_access"]}'::jsonb
WHERE key = 'outlook';

-- ── Microsoft Calendar (child row) ────────────────────────────────────────
UPDATE integrations
SET manifest = COALESCE(manifest, '{}'::jsonb) || '{"default_scopes": ["Calendars.Read", "User.Read", "offline_access"]}'::jsonb
WHERE key = 'microsoft_calendar';

-- ── Teams (child row) ─────────────────────────────────────────────────────
UPDATE integrations
SET manifest = COALESCE(manifest, '{}'::jsonb) || '{"default_scopes": ["Chat.Read", "User.Read", "offline_access"]}'::jsonb
WHERE key = 'teams';
