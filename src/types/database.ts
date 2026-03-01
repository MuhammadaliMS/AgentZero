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
          category: 'decision' | 'context' | 'preference' | 'relationship' | 'fact'
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
          category: 'decision' | 'context' | 'preference' | 'relationship' | 'fact'
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
          category?: 'decision' | 'context' | 'preference' | 'relationship' | 'fact'
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
          created_at?: string
        }
        Update: {
          title?: string
          content?: Json
          status?: 'draft' | 'sent' | 'read'
          sent_at?: string | null
          sent_via?: string | null
          slack_message_ts?: string | null
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
          sent_at?: string | null
          created_at?: string
        }
        Update: {
          status?: 'pending' | 'sent' | 'acknowledged' | 'dismissed'
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
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
