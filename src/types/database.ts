export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string
          name: string
          slug: string
          domain: string | null
          settings: Json | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          domain?: string | null
          settings?: Json | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          domain?: string | null
          settings?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          id: string
          org_id: string
          email: string
          full_name: string
          role: string
          title: string | null
          timezone: string
          communication_style: string
          notification_channel: string
          settings: Json | null
          onboarded_at: string | null
          slack_user_id: string | null
          avatar_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          org_id: string
          email: string
          full_name: string
          role?: string
          title?: string | null
          timezone?: string
          communication_style?: string
          notification_channel?: string
          settings?: Json | null
          onboarded_at?: string | null
          slack_user_id?: string | null
          avatar_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          org_id?: string
          email?: string
          full_name?: string
          role?: string
          title?: string | null
          timezone?: string
          communication_style?: string
          notification_channel?: string
          settings?: Json | null
          onboarded_at?: string | null
          slack_user_id?: string | null
          avatar_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'profiles_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      conversations: {
        Row: {
          id: string
          org_id: string
          user_id: string
          title: string | null
          session_id: string | null
          status: 'active' | 'archived' | 'deleted'
          pinned: boolean
          archived_at: string | null
          metadata: Json | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          title?: string | null
          session_id?: string | null
          status?: 'active' | 'archived' | 'deleted'
          pinned?: boolean
          archived_at?: string | null
          metadata?: Json | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          title?: string | null
          session_id?: string | null
          status?: 'active' | 'archived' | 'deleted'
          pinned?: boolean
          archived_at?: string | null
          metadata?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'conversations_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'conversations_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          role: 'user' | 'assistant' | 'system'
          content: string
          parts: Json | null
          metadata: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id: string
          role: 'user' | 'assistant' | 'system'
          content: string
          parts?: Json | null
          metadata?: Json | null
          created_at?: string
        }
        Update: {
          content?: string
          parts?: Json | null
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey'
            columns: ['conversation_id']
            isOneToOne: false
            referencedRelation: 'conversations'
            referencedColumns: ['id']
          },
        ]
      }
      commitments: {
        Row: {
          id: string
          org_id: string
          owner_id: string | null
          conversation_id: string | null
          title: string
          description: string | null
          source: string | null
          source_ref: string | null
          status: 'active' | 'at_risk' | 'overdue' | 'completed' | 'cancelled'
          priority: 'critical' | 'high' | 'medium' | 'low'
          due_date: string | null
          completed_at: string | null
          tags: string[] | null
          metadata: Json | null
          risk_score: number
          risk_computed_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          owner_id?: string | null
          conversation_id?: string | null
          title: string
          description?: string | null
          source?: string | null
          source_ref?: string | null
          status?: 'active' | 'at_risk' | 'overdue' | 'completed' | 'cancelled'
          priority?: 'critical' | 'high' | 'medium' | 'low'
          due_date?: string | null
          completed_at?: string | null
          tags?: string[] | null
          metadata?: Json | null
          risk_score?: number
          risk_computed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          owner_id?: string | null
          conversation_id?: string | null
          title?: string
          description?: string | null
          source?: string | null
          source_ref?: string | null
          status?: 'active' | 'at_risk' | 'overdue' | 'completed' | 'cancelled'
          priority?: 'critical' | 'high' | 'medium' | 'low'
          due_date?: string | null
          completed_at?: string | null
          tags?: string[] | null
          metadata?: Json | null
          risk_score?: number
          risk_computed_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'commitments_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      memory: {
        Row: {
          id: string
          org_id: string
          category: 'decision' | 'context' | 'preference' | 'relationship' | 'fact' | 'task' | 'meeting_outcome' | 'project_status' | 'blocker' | 'deadline'
          subject: string
          content: string
          source: string | null
          confidence: number
          related_entities: string[] | null
          expires_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          category: 'decision' | 'context' | 'preference' | 'relationship' | 'fact' | 'task' | 'meeting_outcome' | 'project_status' | 'blocker' | 'deadline'
          subject: string
          content: string
          source?: string | null
          confidence?: number
          related_entities?: string[] | null
          expires_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          category?: 'decision' | 'context' | 'preference' | 'relationship' | 'fact' | 'task' | 'meeting_outcome' | 'project_status' | 'blocker' | 'deadline'
          subject?: string
          content?: string
          source?: string | null
          confidence?: number
          related_entities?: string[] | null
          expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'memory_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      actions: {
        Row: {
          id: string
          org_id: string
          user_id: string
          conversation_id: string | null
          type: string
          title: string
          description: string | null
          payload: Json | null
          status: 'pending' | 'approved' | 'rejected' | 'deferred' | 'expired'
          priority: 'critical' | 'high' | 'medium' | 'low'
          due_at: string | null
          resolved_at: string | null
          resolved_by: string | null
          slack_message_ts: string | null
          slack_channel_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          conversation_id?: string | null
          type: string
          title: string
          description?: string | null
          payload?: Json | null
          status?: 'pending' | 'approved' | 'rejected' | 'deferred' | 'expired'
          priority?: 'critical' | 'high' | 'medium' | 'low'
          due_at?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          slack_message_ts?: string | null
          slack_channel_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          conversation_id?: string | null
          type?: string
          title?: string
          description?: string | null
          payload?: Json | null
          status?: 'pending' | 'approved' | 'rejected' | 'deferred' | 'expired'
          priority?: 'critical' | 'high' | 'medium' | 'low'
          due_at?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          slack_message_ts?: string | null
          slack_channel_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'actions_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'actions_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      briefs: {
        Row: {
          id: string
          org_id: string
          user_id: string
          type: 'morning' | 'eod' | 'weekly' | 'ad_hoc'
          title: string
          content: Json
          status: 'draft' | 'sent' | 'read'
          sent_at: string | null
          sent_via: string | null
          slack_message_ts: string | null
          metrics: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          type: 'morning' | 'eod' | 'weekly' | 'ad_hoc'
          title: string
          content: Json
          status?: 'draft' | 'sent' | 'read'
          sent_at?: string | null
          sent_via?: string | null
          slack_message_ts?: string | null
          metrics?: Json | null
          created_at?: string
        }
        Update: {
          title?: string
          content?: Json
          status?: 'draft' | 'sent' | 'read'
          sent_at?: string | null
          sent_via?: string | null
          slack_message_ts?: string | null
          metrics?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: 'briefs_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'briefs_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      worker_executions: {
        Row: {
          id: string
          org_id: string
          conversation_id: string | null
          worker: string
          trigger: string | null
          input_summary: string | null
          output_summary: string | null
          status: 'running' | 'completed' | 'failed'
          duration_ms: number | null
          tokens_used: Json | null
          cost_usd: number | null
          error: string | null
          created_at: string
          completed_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          conversation_id?: string | null
          worker: string
          trigger?: string | null
          input_summary?: string | null
          output_summary?: string | null
          status?: 'running' | 'completed' | 'failed'
          duration_ms?: number | null
          tokens_used?: Json | null
          cost_usd?: number | null
          error?: string | null
          created_at?: string
          completed_at?: string | null
        }
        Update: {
          output_summary?: string | null
          status?: 'running' | 'completed' | 'failed'
          duration_ms?: number | null
          tokens_used?: Json | null
          cost_usd?: number | null
          error?: string | null
          completed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'worker_executions_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      nudges: {
        Row: {
          id: string
          org_id: string
          user_id: string
          type: string
          title: string
          content: string
          priority: 'critical' | 'high' | 'medium' | 'low'
          status: 'pending' | 'sent' | 'acknowledged' | 'dismissed'
          action_id: string | null
          commitment_id: string | null
          urgency_score: number
          source_finding_id: string | null
          batch_id: string | null
          sent_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          type: string
          title: string
          content: string
          priority?: 'critical' | 'high' | 'medium' | 'low'
          status?: 'pending' | 'sent' | 'acknowledged' | 'dismissed'
          action_id?: string | null
          commitment_id?: string | null
          urgency_score?: number
          source_finding_id?: string | null
          batch_id?: string | null
          sent_at?: string | null
          created_at?: string
        }
        Update: {
          status?: 'pending' | 'sent' | 'acknowledged' | 'dismissed'
          commitment_id?: string | null
          urgency_score?: number
          source_finding_id?: string | null
          batch_id?: string | null
          sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'nudges_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'nudges_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      integrations: {
        Row: {
          id: string
          key: string
          vendor: string
          name: string
          description: string | null
          logo_url: string | null
          auth_type: 'oauth2' | 'api_key'
          category: string
          status: 'active' | 'upcoming'
          manifest: Json | null
          instructions: Json | null
          parent_integration_id: string | null
          display_order: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          key: string
          vendor: string
          name: string
          description?: string | null
          logo_url?: string | null
          auth_type: 'oauth2' | 'api_key'
          category: string
          status?: 'active' | 'upcoming'
          manifest?: Json | null
          instructions?: Json | null
          parent_integration_id?: string | null
          display_order?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          name?: string
          description?: string | null
          logo_url?: string | null
          status?: 'active' | 'upcoming'
          manifest?: Json | null
          instructions?: Json | null
          display_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      integration_permissions: {
        Row: {
          id: string
          integration_id: string
          scope: string
          display_name: string
          description: string | null
          is_mandatory: boolean
          created_at: string
        }
        Insert: {
          id?: string
          integration_id: string
          scope: string
          display_name: string
          description?: string | null
          is_mandatory?: boolean
          created_at?: string
        }
        Update: {
          display_name?: string
          description?: string | null
          is_mandatory?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'integration_permissions_integration_id_fkey'
            columns: ['integration_id']
            isOneToOne: false
            referencedRelation: 'integrations'
            referencedColumns: ['id']
          },
        ]
      }
      organization_integrations: {
        Row: {
          id: string
          org_id: string
          integration_id: string
          granted_scopes: string[] | null
          is_active: boolean
          health_status: 'unknown' | 'healthy' | 'degraded' | 'error'
          failure_error: string | null
          last_health_check: string | null
          token_data: Json | null
          token_expires_at: string | null
          user_metadata: Json | null
          connected_by: string | null
          disconnected_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          integration_id: string
          granted_scopes?: string[] | null
          is_active?: boolean
          health_status?: 'unknown' | 'healthy' | 'degraded' | 'error'
          failure_error?: string | null
          last_health_check?: string | null
          token_data?: Json | null
          token_expires_at?: string | null
          user_metadata?: Json | null
          connected_by?: string | null
          disconnected_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          granted_scopes?: string[] | null
          is_active?: boolean
          health_status?: 'unknown' | 'healthy' | 'degraded' | 'error'
          failure_error?: string | null
          last_health_check?: string | null
          token_data?: Json | null
          token_expires_at?: string | null
          user_metadata?: Json | null
          disconnected_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'organization_integrations_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'organization_integrations_integration_id_fkey'
            columns: ['integration_id']
            isOneToOne: false
            referencedRelation: 'integrations'
            referencedColumns: ['id']
          },
        ]
      }
      entities: {
        Row: {
          id: string
          org_id: string
          entity_type: 'person' | 'project' | 'control' | 'decision' | 'team' | 'tool' | 'vendor' | 'framework' | 'document' | 'process'
          name: string
          canonical_name: string
          description: string | null
          attributes: Json | null
          embedding: string | null
          first_seen_at: string
          last_seen_at: string
          mention_count: number
          created_at: string
          updated_at: string
          access_count: number
          last_accessed_at: string | null
          utility_score: number
          state: 'active' | 'dormant' | 'archived' | 'pinned' | 'conflicted'
          is_pinned: boolean
          memory_class: 'person' | 'project' | 'decision' | 'control' | 'team' | 'tool' | 'vendor' | 'framework' | 'document' | 'process' | 'default'
          last_decay_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          entity_type: 'person' | 'project' | 'control' | 'decision' | 'team' | 'tool' | 'vendor' | 'framework' | 'document' | 'process'
          name: string
          canonical_name: string
          description?: string | null
          attributes?: Json | null
          embedding?: string | null
          first_seen_at?: string
          last_seen_at?: string
          mention_count?: number
          created_at?: string
          updated_at?: string
          access_count?: number
          last_accessed_at?: string | null
          utility_score?: number
          state?: 'active' | 'dormant' | 'archived' | 'pinned' | 'conflicted'
          is_pinned?: boolean
          memory_class?: 'person' | 'project' | 'decision' | 'control' | 'team' | 'tool' | 'vendor' | 'framework' | 'document' | 'process' | 'default'
          last_decay_at?: string | null
        }
        Update: {
          name?: string
          description?: string | null
          attributes?: Json | null
          embedding?: string | null
          last_seen_at?: string
          mention_count?: number
          updated_at?: string
          access_count?: number
          last_accessed_at?: string | null
          utility_score?: number
          state?: 'active' | 'dormant' | 'archived' | 'pinned' | 'conflicted'
          is_pinned?: boolean
          memory_class?: 'person' | 'project' | 'decision' | 'control' | 'team' | 'tool' | 'vendor' | 'framework' | 'document' | 'process' | 'default'
          last_decay_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'entities_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      entity_relationships: {
        Row: {
          id: string
          org_id: string
          source_entity_id: string
          target_entity_id: string
          relationship_type: string
          properties: Json | null
          confidence: number
          valid_from: string
          valid_to: string | null
          source_conversation_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          source_entity_id: string
          target_entity_id: string
          relationship_type: string
          properties?: Json | null
          confidence?: number
          valid_from?: string
          valid_to?: string | null
          source_conversation_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          relationship_type?: string
          properties?: Json | null
          confidence?: number
          valid_to?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'entity_relationships_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'entity_relationships_source_entity_id_fkey'
            columns: ['source_entity_id']
            isOneToOne: false
            referencedRelation: 'entities'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'entity_relationships_target_entity_id_fkey'
            columns: ['target_entity_id']
            isOneToOne: false
            referencedRelation: 'entities'
            referencedColumns: ['id']
          },
        ]
      }
      memory_embeddings: {
        Row: {
          id: string
          memory_id: string
          embedding: string
          model: string
          created_at: string
        }
        Insert: {
          id?: string
          memory_id: string
          embedding: string
          model?: string
          created_at?: string
        }
        Update: {
          embedding?: string
          model?: string
        }
        Relationships: [
          {
            foreignKeyName: 'memory_embeddings_memory_id_fkey'
            columns: ['memory_id']
            isOneToOne: true
            referencedRelation: 'memory'
            referencedColumns: ['id']
          },
        ]
      }
      memory_entity_links: {
        Row: {
          id: string
          memory_id: string
          entity_id: string
        }
        Insert: {
          id?: string
          memory_id: string
          entity_id: string
        }
        Update: Record<string, never>
        Relationships: [
          {
            foreignKeyName: 'memory_entity_links_memory_id_fkey'
            columns: ['memory_id']
            isOneToOne: false
            referencedRelation: 'memory'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'memory_entity_links_entity_id_fkey'
            columns: ['entity_id']
            isOneToOne: false
            referencedRelation: 'entities'
            referencedColumns: ['id']
          },
        ]
      }
      extraction_jobs: {
        Row: {
          id: string
          org_id: string
          conversation_id: string | null
          message_id: string | null
          status: 'pending' | 'processing' | 'completed' | 'failed'
          entities_extracted: number | null
          relationships_extracted: number | null
          embeddings_generated: number | null
          error: string | null
          model_used: string | null
          tokens_used: Json | null
          cost_usd: number | null
          duration_ms: number | null
          created_at: string
          completed_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          conversation_id?: string | null
          message_id?: string | null
          status?: 'pending' | 'processing' | 'completed' | 'failed'
          entities_extracted?: number | null
          relationships_extracted?: number | null
          embeddings_generated?: number | null
          error?: string | null
          model_used?: string | null
          tokens_used?: Json | null
          cost_usd?: number | null
          duration_ms?: number | null
          created_at?: string
          completed_at?: string | null
        }
        Update: {
          status?: 'pending' | 'processing' | 'completed' | 'failed'
          entities_extracted?: number | null
          relationships_extracted?: number | null
          embeddings_generated?: number | null
          error?: string | null
          tokens_used?: Json | null
          cost_usd?: number | null
          duration_ms?: number | null
          completed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'extraction_jobs_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      pending_approvals: {
        Row: {
          approval_id: string
          conversation_id: string
          org_id: string
          tool_name: string
          tool_input: Json
          status: 'pending' | 'approved' | 'rejected'
          created_at: string
          resolved_at: string | null
          expires_at: string
        }
        Insert: {
          approval_id: string
          conversation_id: string
          org_id: string
          tool_name: string
          tool_input?: Json
          status?: 'pending' | 'approved' | 'rejected'
          created_at?: string
          resolved_at?: string | null
          expires_at: string
        }
        Update: {
          status?: 'pending' | 'approved' | 'rejected'
          resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'pending_approvals_conversation_id_fkey'
            columns: ['conversation_id']
            isOneToOne: false
            referencedRelation: 'conversations'
            referencedColumns: ['id']
          },
        ]
      }
      onboarding_state: {
        Row: {
          id: string
          org_id: string
          user_id: string
          current_step: number
          is_complete: boolean
          steps: Json
          completed_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          current_step?: number
          is_complete?: boolean
          steps?: Json
          completed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          current_step?: number
          is_complete?: boolean
          steps?: Json
          completed_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'onboarding_state_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'onboarding_state_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      patrol_findings: {
        Row: {
          id: string
          org_id: string
          type: 'deadline_approaching' | 'deadline_overdue' | 'stale_entity' | 'failing_control' | 'unresolved_blocker' | 'at_risk_commitment' | 'action_expiring' | 'cross_signal_risk' | 'discovered_commitment' | 'integration_insight' | 'compliance_gap' | 'stakeholder_signal' | 'deadline_conflict' | 'anomaly_detected' | 'recurring_pattern' | 'opportunity_identified'
          severity: 'critical' | 'high' | 'medium' | 'low'
          title: string
          description: string | null
          entity_id: string | null
          commitment_id: string | null
          action_id: string | null
          memory_id: string | null
          metadata: Json | null
          status: 'open' | 'acknowledged' | 'resolved' | 'expired'
          resolved_at: string | null
          expires_at: string | null
          created_at: string
          source_integrations: string[]
          scan_type: 'db' | 'agentic'
          agentic_scan_id: string | null
        }
        Insert: {
          id?: string
          org_id: string
          type: 'deadline_approaching' | 'deadline_overdue' | 'stale_entity' | 'failing_control' | 'unresolved_blocker' | 'at_risk_commitment' | 'action_expiring' | 'cross_signal_risk' | 'discovered_commitment' | 'integration_insight' | 'compliance_gap' | 'stakeholder_signal' | 'deadline_conflict' | 'anomaly_detected' | 'recurring_pattern' | 'opportunity_identified'
          severity: 'critical' | 'high' | 'medium' | 'low'
          title: string
          description?: string | null
          entity_id?: string | null
          commitment_id?: string | null
          action_id?: string | null
          memory_id?: string | null
          metadata?: Json | null
          status?: 'open' | 'acknowledged' | 'resolved' | 'expired'
          resolved_at?: string | null
          expires_at?: string | null
          created_at?: string
          source_integrations?: string[]
          scan_type?: 'db' | 'agentic'
          agentic_scan_id?: string | null
        }
        Update: {
          severity?: 'critical' | 'high' | 'medium' | 'low'
          title?: string
          description?: string | null
          metadata?: Json | null
          status?: 'open' | 'acknowledged' | 'resolved' | 'expired'
          resolved_at?: string | null
          expires_at?: string | null
          source_integrations?: string[]
          scan_type?: 'db' | 'agentic'
          agentic_scan_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'patrol_findings_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      feedback_signals: {
        Row: {
          id: string
          org_id: string
          user_id: string
          signal_type: 'brief_read' | 'nudge_acknowledged' | 'nudge_dismissed' | 'commitment_acted_on' | 'action_resolved_after_nudge'
          source_type: 'brief' | 'nudge' | 'commitment' | 'action'
          source_id: string
          category: string | null
          metadata: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          signal_type: 'brief_read' | 'nudge_acknowledged' | 'nudge_dismissed' | 'commitment_acted_on' | 'action_resolved_after_nudge'
          source_type: 'brief' | 'nudge' | 'commitment' | 'action'
          source_id: string
          category?: string | null
          metadata?: Json | null
          created_at?: string
        }
        Update: {
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: 'feedback_signals_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'feedback_signals_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      user_signal_weights: {
        Row: {
          id: string
          org_id: string
          user_id: string
          category: string
          weight: number
          acted_count: number
          dismissed_count: number
          total_count: number
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id: string
          category: string
          weight?: number
          acted_count?: number
          dismissed_count?: number
          total_count?: number
          updated_at?: string
        }
        Update: {
          weight?: number
          acted_count?: number
          dismissed_count?: number
          total_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'user_signal_weights_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'user_signal_weights_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      graph_insights: {
        Row: {
          id: string
          org_id: string
          idempotency_key: string
          insight_type: string
          category: string | null
          summary: string
          confidence: number
          utility_score: number
          related_entity_ids: string[]
          evidence: Json
          action_template: Json | null
          source_conversation_id: string | null
          status: string
          routed_finding_id: string | null
          superseded_by: string | null
          times_triggered: number
          last_triggered_at: string
          expires_at: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          idempotency_key: string
          insight_type: string
          category?: string | null
          summary: string
          confidence?: number
          utility_score?: number
          related_entity_ids?: string[]
          evidence?: Json
          action_template?: Json | null
          source_conversation_id?: string | null
          status?: string
          routed_finding_id?: string | null
          superseded_by?: string | null
          times_triggered?: number
          last_triggered_at?: string
          expires_at?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          insight_type?: string
          category?: string | null
          summary?: string
          confidence?: number
          utility_score?: number
          related_entity_ids?: string[]
          evidence?: Json
          action_template?: Json | null
          status?: string
          routed_finding_id?: string | null
          superseded_by?: string | null
          times_triggered?: number
          last_triggered_at?: string
          expires_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'graph_insights_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      insight_actions: {
        Row: {
          id: string
          org_id: string
          insight_id: string
          finding_id: string | null
          action_id: string | null
          decision_mode: string
          policy_path: string | null
          execution_result: string
          outcome_notes: string | null
          created_at: string
          resolved_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          insight_id: string
          finding_id?: string | null
          action_id?: string | null
          decision_mode: string
          policy_path?: string | null
          execution_result?: string
          outcome_notes?: string | null
          created_at?: string
          resolved_at?: string | null
        }
        Update: {
          execution_result?: string
          outcome_notes?: string | null
          resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'insight_actions_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'insight_actions_insight_id_fkey'
            columns: ['insight_id']
            isOneToOne: false
            referencedRelation: 'graph_insights'
            referencedColumns: ['id']
          },
        ]
      }
      contradiction_resolutions: {
        Row: {
          id: string
          org_id: string
          contradiction_id: string
          chosen_truth: Json
          resolver_id: string | null
          resolution_source: string
          rationale: string | null
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          contradiction_id: string
          chosen_truth: Json
          resolver_id?: string | null
          resolution_source: string
          rationale?: string | null
          created_at?: string
        }
        Update: {
          rationale?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'contradiction_resolutions_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'contradiction_resolutions_contradiction_id_fkey'
            columns: ['contradiction_id']
            isOneToOne: false
            referencedRelation: 'graph_insights'
            referencedColumns: ['id']
          },
        ]
      }
      memory_utility_events: {
        Row: {
          id: string
          org_id: string
          entity_id: string | null
          memory_id: string | null
          insight_id: string | null
          event_type: string
          conversation_id: string | null
          source_channel: string | null
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          entity_id?: string | null
          memory_id?: string | null
          insight_id?: string | null
          event_type: string
          conversation_id?: string | null
          source_channel?: string | null
          created_at?: string
        }
        Update: Record<string, never>
        Relationships: [
          {
            foreignKeyName: 'memory_utility_events_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      decision_cards: {
        Row: {
          id: string
          org_id: string
          conversation_id: string | null
          trigger_type: string
          trigger_source: string | null
          objective: string
          context_summary: string | null
          hypotheses: Json
          options_considered: Json
          chosen_action: string
          confidence: number
          why_now: string | null
          risk_notes: string | null
          related_entity_ids: string[]
          related_insight_ids: string[]
          model_used: string | null
          reasoning_tokens: number | null
          latency_ms: number | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          conversation_id?: string | null
          trigger_type: string
          trigger_source?: string | null
          objective: string
          context_summary?: string | null
          hypotheses?: Json
          options_considered?: Json
          chosen_action: string
          confidence: number
          why_now?: string | null
          risk_notes?: string | null
          related_entity_ids?: string[]
          related_insight_ids?: string[]
          model_used?: string | null
          reasoning_tokens?: number | null
          latency_ms?: number | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          objective?: string
          context_summary?: string | null
          chosen_action?: string
          confidence?: number
          why_now?: string | null
          risk_notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'decision_cards_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: Record<string, never>
    Functions: {
      get_entity_neighborhood: {
        Args: {
          p_entity_id: string
          p_org_id: string
          p_max_hops?: number
          p_active_only?: boolean
        }
        Returns: Array<{
          entity_id: string
          entity_name: string
          entity_type: string
          entity_description: string | null
          hop_distance: number
          relationship_type: string | null
          relationship_direction: string | null
          relationship_properties: Record<string, unknown> | null
          valid_from: string | null
          valid_to: string | null
        }>
      }
      get_entity_timeline: {
        Args: {
          p_entity_id: string
          p_org_id: string
          p_since?: string | null
        }
        Returns: Array<{
          event_time: string
          event_type: string
          relationship_type: string
          related_entity_name: string
          related_entity_type: string
          properties: Record<string, unknown> | null
          valid_to: string | null
        }>
      }
      search_memories_by_embedding: {
        Args: {
          p_org_id: string
          p_embedding: string
          p_limit?: number
          p_category?: string | null
        }
        Returns: Array<{
          memory_id: string
          subject: string
          content: string
          category: string
          confidence: number
          similarity: number
          related_entities: string[]
          created_at: string
        }>
      }
      get_relevant_entities: {
        Args: {
          p_org_id: string
          p_limit?: number
          p_min_relevance?: number
        }
        Returns: Array<{
          entity_id: string
          entity_name: string
          entity_type: string
          mention_count: number
          relevance_score: number
          entity_state: string
        }>
      }
      search_entities_by_embedding: {
        Args: {
          p_org_id: string
          p_embedding: string
          p_limit?: number
          p_min_similarity?: number
        }
        Returns: Array<{
          entity_id: string
          entity_name: string
          entity_type: string
          entity_description: string | null
          canonical_name: string
          similarity: number
          mention_count: number
          entity_state: string
          utility: number
        }>
      }
      bump_entity_access: {
        Args: {
          p_org_id: string
          p_entity_ids: string[]
        }
        Returns: undefined
      }
      upsert_insight_with_dedupe: {
        Args: {
          p_org_id: string
          p_idempotency_key: string
          p_insight_type: string
          p_category: string | null
          p_summary: string
          p_confidence: number
          p_entity_ids: string[]
          p_evidence: Json
          p_action_template: Json | null
        }
        Returns: string // UUID of the upserted insight
      }
      find_repetitive_relationships: {
        Args: {
          p_org_id: string
          p_min_repetitions?: number
        }
        Returns: Array<{
          source_entity_id: string
          source_entity_name: string
          target_entity_id: string
          target_entity_name: string
          relationship_type: string
          repetition_count: number
          avg_confidence: number
          conversation_ids: string[]
          earliest: string
          latest: string
        }>
      }
      detect_velocity_spikes: {
        Args: {
          p_org_id: string
          p_spike_threshold?: number
        }
        Returns: Array<{
          entity_id: string
          entity_name: string
          entity_type: string
          recent_7d_count: number
          avg_30d_weekly: number
          spike_ratio: number
        }>
      }
      find_co_occurring_entities: {
        Args: {
          p_org_id: string
          p_min_co_occurrences?: number
          p_limit?: number
        }
        Returns: Array<{
          entity_a_id: string
          entity_b_id: string
          entity_a_name: string
          entity_b_name: string
          co_occurrence_count: number
        }>
      }
      apply_decay_cycle: {
        Args: {
          p_org_id: string
        }
        Returns: Array<{
          transitioned_to_dormant: number
          transitioned_to_archived: number
        }>
      }
      get_decision_cards_for_conversation: {
        Args: {
          p_org_id: string
          p_conversation_id: string
          p_limit?: number
        }
        Returns: Array<{
          id: string
          org_id: string
          conversation_id: string | null
          trigger_type: string
          trigger_source: string | null
          objective: string
          context_summary: string | null
          hypotheses: Json
          options_considered: Json
          chosen_action: string
          confidence: number
          why_now: string | null
          risk_notes: string | null
          related_entity_ids: string[]
          related_insight_ids: string[]
          model_used: string | null
          reasoning_tokens: number | null
          latency_ms: number | null
          created_at: string
          updated_at: string
        }>
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
