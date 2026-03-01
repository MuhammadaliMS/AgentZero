-- Migration 3: RLS, Triggers, Seed Data

-- ============================================================
-- Updated-at trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER set_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON commitments FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON memory FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON actions FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON organization_integrations FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON onboarding_state FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- ============================================================
-- Auto-create org + profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_org_id UUID;
  user_full_name TEXT;
  org_name TEXT;
  org_slug TEXT;
BEGIN
  -- Extract name from metadata
  user_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email);
  org_name := COALESCE(NEW.raw_user_meta_data->>'org_name', user_full_name || '''s Organization');
  org_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));

  -- Ensure slug uniqueness
  org_slug := org_slug || '-' || substr(NEW.id::text, 1, 8);

  -- Create organization
  INSERT INTO public.organizations (name, slug)
  VALUES (org_name, org_slug)
  RETURNING id INTO new_org_id;

  -- Create profile
  INSERT INTO public.profiles (id, org_id, email, full_name)
  VALUES (NEW.id, new_org_id, NEW.email, user_full_name);

  -- Create onboarding state
  INSERT INTO public.onboarding_state (org_id, user_id, steps)
  VALUES (new_org_id, NEW.id, '[]'::jsonb);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- Row Level Security
-- ============================================================

-- Helper: get user's org_id (in public schema — auth schema is restricted)
CREATE OR REPLACE FUNCTION public.user_org_id()
RETURNS UUID AS $$
  SELECT org_id FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Organizations
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own org" ON organizations FOR SELECT USING (id = public.user_org_id());
CREATE POLICY "Users can update their own org" ON organizations FOR UPDATE USING (id = public.user_org_id());

-- Profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view profiles in their org" ON profiles FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Users can update their own profile" ON profiles FOR UPDATE USING (id = auth.uid());

-- Conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their conversations" ON conversations FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Users can create conversations" ON conversations FOR INSERT WITH CHECK (org_id = public.user_org_id() AND user_id = auth.uid());
CREATE POLICY "Users can update their conversations" ON conversations FOR UPDATE USING (org_id = public.user_org_id() AND user_id = auth.uid());

-- Messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view messages in their conversations" ON messages FOR SELECT
  USING (conversation_id IN (SELECT id FROM conversations WHERE org_id = public.user_org_id()));
CREATE POLICY "Users can insert messages in their conversations" ON messages FOR INSERT
  WITH CHECK (conversation_id IN (SELECT id FROM conversations WHERE org_id = public.user_org_id() AND user_id = auth.uid()));

-- Commitments
ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view commitments" ON commitments FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Org members can create commitments" ON commitments FOR INSERT WITH CHECK (org_id = public.user_org_id());
CREATE POLICY "Org members can update commitments" ON commitments FOR UPDATE USING (org_id = public.user_org_id());

-- Memory
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view memory" ON memory FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Org members can create memory" ON memory FOR INSERT WITH CHECK (org_id = public.user_org_id());
CREATE POLICY "Org members can update memory" ON memory FOR UPDATE USING (org_id = public.user_org_id());

-- Actions
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view actions" ON actions FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Org members can create actions" ON actions FOR INSERT WITH CHECK (org_id = public.user_org_id());
CREATE POLICY "Org members can update actions" ON actions FOR UPDATE USING (org_id = public.user_org_id());

-- Briefs
ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their briefs" ON briefs FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Users can create briefs" ON briefs FOR INSERT WITH CHECK (org_id = public.user_org_id());

-- Worker Executions
ALTER TABLE worker_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view executions" ON worker_executions FOR SELECT USING (org_id = public.user_org_id());

-- Nudges
ALTER TABLE nudges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their nudges" ON nudges FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Users can update their nudges" ON nudges FOR UPDATE USING (org_id = public.user_org_id() AND user_id = auth.uid());

-- Integrations (catalog - readable by all authenticated users)
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view integration catalog" ON integrations FOR SELECT TO authenticated USING (true);

-- Integration Permissions
ALTER TABLE integration_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view permissions" ON integration_permissions FOR SELECT TO authenticated USING (true);

-- Organization Integrations
ALTER TABLE organization_integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view their integrations" ON organization_integrations FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Org members can manage their integrations" ON organization_integrations FOR INSERT WITH CHECK (org_id = public.user_org_id());
CREATE POLICY "Org members can update their integrations" ON organization_integrations FOR UPDATE USING (org_id = public.user_org_id());
CREATE POLICY "Org members can delete their integrations" ON organization_integrations FOR DELETE USING (org_id = public.user_org_id());

-- Onboarding State
ALTER TABLE onboarding_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their onboarding" ON onboarding_state FOR SELECT USING (org_id = public.user_org_id());
CREATE POLICY "Users can update their onboarding" ON onboarding_state FOR UPDATE USING (org_id = public.user_org_id() AND user_id = auth.uid());

-- ============================================================
-- Seed Integration Catalog
-- ============================================================

-- Slack
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest) VALUES
('slack', 'Slack', 'Slack', 'Connect Slack to receive briefs, nudges, and chat with your Chief of Staff via DM.', 'oauth2', 'messenger', 1,
  '{"oauth_authorize_url": "https://slack.com/oauth/v2/authorize", "oauth_token_url": "https://slack.com/api/oauth.v2.access", "default_scopes": ["channels:read", "chat:write", "im:write", "im:history", "users:read", "users:read.email"], "client_id_env_key": "SLACK_CLIENT_ID", "client_secret_env_key": "SLACK_CLIENT_SECRET"}'::jsonb);

-- Gmail
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest) VALUES
('gmail', 'Google', 'Gmail', 'Connect Gmail to let your Chief of Staff read and draft emails on your behalf.', 'oauth2', 'email', 2,
  '{"oauth_authorize_url": "https://accounts.google.com/o/oauth2/v2/auth", "oauth_token_url": "https://oauth2.googleapis.com/token", "default_scopes": ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"], "client_id_env_key": "GOOGLE_CLIENT_ID", "client_secret_env_key": "GOOGLE_CLIENT_SECRET"}'::jsonb);

-- Google Calendar
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest) VALUES
('google_calendar', 'Google', 'Google Calendar', 'Connect Google Calendar to track meetings, find conflicts, and manage your schedule.', 'oauth2', 'calendar', 3,
  '{"oauth_authorize_url": "https://accounts.google.com/o/oauth2/v2/auth", "oauth_token_url": "https://oauth2.googleapis.com/token", "default_scopes": ["https://www.googleapis.com/auth/calendar.readonly"], "client_id_env_key": "GOOGLE_CLIENT_ID", "client_secret_env_key": "GOOGLE_CLIENT_SECRET"}'::jsonb);

-- Microsoft 365 (parent)
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest) VALUES
('microsoft_365', 'Microsoft', 'Microsoft 365', 'Connect Microsoft 365 for Outlook email, calendar, and Teams integration.', 'oauth2', 'email', 4,
  '{"oauth_authorize_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "oauth_token_url": "https://login.microsoftonline.com/common/oauth2/v2.0/token", "default_scopes": ["Mail.Read", "Mail.Send", "Calendars.Read", "User.Read", "offline_access"], "client_id_env_key": "MICROSOFT_CLIENT_ID", "client_secret_env_key": "MICROSOFT_CLIENT_SECRET"}'::jsonb);

-- Microsoft children
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, parent_integration_id) VALUES
('outlook', 'Microsoft', 'Outlook', 'Email via Microsoft 365', 'oauth2', 'email', 5, (SELECT id FROM integrations WHERE key = 'microsoft_365')),
('microsoft_calendar', 'Microsoft', 'Microsoft Calendar', 'Calendar via Microsoft 365', 'oauth2', 'calendar', 6, (SELECT id FROM integrations WHERE key = 'microsoft_365')),
('teams', 'Microsoft', 'Microsoft Teams', 'Teams messaging via Microsoft 365', 'oauth2', 'messenger', 7, (SELECT id FROM integrations WHERE key = 'microsoft_365'));

-- Vanta
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest, instructions) VALUES
('vanta', 'Vanta', 'Vanta', 'Connect Vanta to monitor your compliance posture, track controls, and audit readiness.', 'api_key', 'risk_and_compliance', 10,
  '{"oauth_token_url": "https://api.vanta.com/oauth/token", "client_id_env_key": "VANTA_CLIENT_ID", "client_secret_env_key": "VANTA_CLIENT_SECRET"}'::jsonb,
  '[{"step": 1, "title": "Get API Credentials", "description": "Go to Vanta Settings > API > Create new API client. Copy the Client ID and Client Secret."},{"step": 2, "title": "Enter Credentials", "description": "Paste your Client ID and Client Secret below."}]'::jsonb);

-- CrowdStrike
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, instructions) VALUES
('crowdstrike', 'CrowdStrike', 'CrowdStrike', 'Connect CrowdStrike Falcon to monitor endpoint security and detection events.', 'api_key', 'endpoint_detection', 11,
  '[{"step": 1, "title": "Create API Client", "description": "Go to Falcon Console > Support > API Clients & Keys. Create a new API client with Read permissions."},{"step": 2, "title": "Enter Credentials", "description": "Paste your Client ID and Client Secret below."}]'::jsonb);

-- Jira
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest) VALUES
('jira', 'Atlassian', 'Jira', 'Connect Jira to track security-related issues, bugs, and project progress.', 'oauth2', 'developer_tools', 20,
  '{"oauth_authorize_url": "https://auth.atlassian.com/authorize", "oauth_token_url": "https://auth.atlassian.com/oauth/token", "default_scopes": ["read:jira-work", "read:jira-user"], "client_id_env_key": "JIRA_CLIENT_ID", "client_secret_env_key": "JIRA_CLIENT_SECRET"}'::jsonb);

-- GitHub
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest) VALUES
('github', 'GitHub', 'GitHub', 'Connect GitHub to track security advisories, PRs, and repository activity.', 'oauth2', 'developer_tools', 21,
  '{"oauth_authorize_url": "https://github.com/login/oauth/authorize", "oauth_token_url": "https://github.com/login/oauth/access_token", "default_scopes": ["repo:status", "read:org"], "client_id_env_key": "GITHUB_CLIENT_ID", "client_secret_env_key": "GITHUB_CLIENT_SECRET"}'::jsonb);

-- Notion
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest) VALUES
('notion', 'Notion', 'Notion', 'Connect Notion to access your knowledge base, wikis, and documentation.', 'oauth2', 'content_management', 22,
  '{"oauth_authorize_url": "https://api.notion.com/v1/oauth/authorize", "oauth_token_url": "https://api.notion.com/v1/oauth/token", "default_scopes": [], "client_id_env_key": "NOTION_CLIENT_ID", "client_secret_env_key": "NOTION_CLIENT_SECRET"}'::jsonb);

-- Zoom
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, manifest) VALUES
('zoom', 'Zoom', 'Zoom', 'Connect Zoom to access meeting recordings, transcripts, and scheduling.', 'oauth2', 'meeting_intelligence', 23,
  '{"oauth_authorize_url": "https://zoom.us/oauth/authorize", "oauth_token_url": "https://zoom.us/oauth/token", "default_scopes": ["meeting:read", "recording:read", "user:read"], "client_id_env_key": "ZOOM_CLIENT_ID", "client_secret_env_key": "ZOOM_CLIENT_SECRET"}'::jsonb);

-- Qualys
INSERT INTO integrations (key, vendor, name, description, auth_type, category, display_order, instructions) VALUES
('qualys', 'Qualys', 'Qualys', 'Connect Qualys to monitor vulnerability scans and security assessments.', 'api_key', 'vulnerability_management', 12,
  '[{"step": 1, "title": "Get API Credentials", "description": "Go to Qualys > Users > New > API User. Note your username and password."},{"step": 2, "title": "Enter Credentials", "description": "Paste your API URL, username, and password below."}]'::jsonb);

-- Seed permissions for key integrations
INSERT INTO integration_permissions (integration_id, scope, display_name, description, is_mandatory) VALUES
((SELECT id FROM integrations WHERE key = 'slack'), 'channels:read', 'Read Channels', 'View channels and their info', true),
((SELECT id FROM integrations WHERE key = 'slack'), 'chat:write', 'Send Messages', 'Send messages to channels', true),
((SELECT id FROM integrations WHERE key = 'slack'), 'im:write', 'Send DMs', 'Send direct messages', true),
((SELECT id FROM integrations WHERE key = 'slack'), 'im:history', 'Read DMs', 'Read DM history', true),
((SELECT id FROM integrations WHERE key = 'slack'), 'users:read', 'Read Users', 'View user profiles', true),
((SELECT id FROM integrations WHERE key = 'gmail'), 'gmail.readonly', 'Read Emails', 'Read your email messages', true),
((SELECT id FROM integrations WHERE key = 'gmail'), 'gmail.send', 'Send Emails', 'Send emails on your behalf', true),
((SELECT id FROM integrations WHERE key = 'google_calendar'), 'calendar.readonly', 'Read Calendar', 'View your calendar events', true);
