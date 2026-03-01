-- Migration 2: Integration Tables
-- Integration catalog, permissions, connected instances, onboarding state

-- Integration Catalog (seeded, read-only for users)
CREATE TABLE integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT NOT NULL UNIQUE,
  vendor TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  logo_url TEXT,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth2', 'api_key')),
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'upcoming')),
  manifest JSONB DEFAULT '{}',
  instructions JSONB DEFAULT '[]',
  parent_integration_id UUID REFERENCES integrations(id),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_integrations_key ON integrations(key);
CREATE INDEX idx_integrations_category ON integrations(category);
CREATE INDEX idx_integrations_parent ON integrations(parent_integration_id);

-- Integration Permissions
CREATE TABLE integration_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  is_mandatory BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(integration_id, scope)
);

-- Connected Integration Instances (per org)
CREATE TABLE organization_integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  granted_scopes TEXT[] DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  failure_error TEXT,
  last_health_check TIMESTAMPTZ,
  token_data JSONB,
  user_metadata JSONB DEFAULT '{}',
  connected_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, integration_id)
);

CREATE INDEX idx_org_integrations_org ON organization_integrations(org_id);
CREATE INDEX idx_org_integrations_active ON organization_integrations(org_id) WHERE is_active = true;

-- Onboarding State
CREATE TABLE onboarding_state (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  current_step INTEGER NOT NULL DEFAULT 0,
  is_complete BOOLEAN NOT NULL DEFAULT false,
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, user_id)
);
