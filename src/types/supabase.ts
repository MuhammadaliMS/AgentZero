export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      actions: {
        Row: {
          conversation_id: string | null
          created_at: string
          description: string | null
          due_at: string | null
          id: string
          org_id: string
          payload: Json | null
          priority: string
          resolved_at: string | null
          resolved_by: string | null
          slack_channel_id: string | null
          slack_message_ts: string | null
          status: string
          title: string
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          id?: string
          org_id: string
          payload?: Json | null
          priority?: string
          resolved_at?: string | null
          resolved_by?: string | null
          slack_channel_id?: string | null
          slack_message_ts?: string | null
          status?: string
          title: string
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          id?: string
          org_id?: string
          payload?: Json | null
          priority?: string
          resolved_at?: string | null
          resolved_by?: string | null
          slack_channel_id?: string | null
          slack_message_ts?: string | null
          status?: string
          title?: string
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "actions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      briefs: {
        Row: {
          content: Json
          created_at: string
          id: string
          metrics: Json | null
          org_id: string
          sent_at: string | null
          sent_via: string | null
          slack_message_ts: string | null
          status: string
          title: string
          type: string
          user_id: string
        }
        Insert: {
          content?: Json
          created_at?: string
          id?: string
          metrics?: Json | null
          org_id: string
          sent_at?: string | null
          sent_via?: string | null
          slack_message_ts?: string | null
          status?: string
          title: string
          type: string
          user_id: string
        }
        Update: {
          content?: Json
          created_at?: string
          id?: string
          metrics?: Json | null
          org_id?: string
          sent_at?: string | null
          sent_via?: string | null
          slack_message_ts?: string | null
          status?: string
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "briefs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chief_loop_events: {
        Row: {
          created_at: string | null
          event_type: string
          id: string
          lease_id: string | null
          metadata: Json | null
          org_id: string
          policy_reason: string | null
          policy_result: string | null
          rationale: string | null
          risk_score: number | null
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          created_at?: string | null
          event_type: string
          id?: string
          lease_id?: string | null
          metadata?: Json | null
          org_id: string
          policy_reason?: string | null
          policy_result?: string | null
          rationale?: string | null
          risk_score?: number | null
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          created_at?: string | null
          event_type?: string
          id?: string
          lease_id?: string | null
          metadata?: Json | null
          org_id?: string
          policy_reason?: string | null
          policy_result?: string | null
          rationale?: string | null
          risk_score?: number | null
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chief_loop_events_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "chief_loop_leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chief_loop_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      chief_loop_leases: {
        Row: {
          acquired_at: string
          carry_forward: string | null
          completed_at: string | null
          cost_usd: number | null
          error: string | null
          expired_at: string | null
          expires_at: string
          id: string
          org_id: string
          outcomes_created: number | null
          result_summary: string | null
          signals_ingested: number | null
          status: string
          steps_executed: number | null
        }
        Insert: {
          acquired_at?: string
          carry_forward?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          error?: string | null
          expired_at?: string | null
          expires_at: string
          id?: string
          org_id: string
          outcomes_created?: number | null
          result_summary?: string | null
          signals_ingested?: number | null
          status?: string
          steps_executed?: number | null
        }
        Update: {
          acquired_at?: string
          carry_forward?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          error?: string | null
          expired_at?: string | null
          expires_at?: string
          id?: string
          org_id?: string
          outcomes_created?: number | null
          result_summary?: string | null
          signals_ingested?: number | null
          status?: string
          steps_executed?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "chief_loop_leases_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      chief_loop_notifications: {
        Row: {
          created_at: string
          decision_summary: string
          decision_type: string
          id: string
          lease_id: string | null
          notification_channel: string
          org_id: string
          risk_score: number
          sent_at: string | null
          status: string
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          created_at?: string
          decision_summary: string
          decision_type: string
          id?: string
          lease_id?: string | null
          notification_channel?: string
          org_id: string
          risk_score: number
          sent_at?: string | null
          status?: string
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          created_at?: string
          decision_summary?: string
          decision_type?: string
          id?: string
          lease_id?: string | null
          notification_channel?: string
          org_id?: string
          risk_score?: number
          sent_at?: string | null
          status?: string
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chief_loop_notifications_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "chief_loop_leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chief_loop_notifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      commitments: {
        Row: {
          completed_at: string | null
          conversation_id: string | null
          created_at: string
          description: string | null
          due_date: string | null
          id: string
          metadata: Json | null
          org_id: string
          owner_id: string | null
          priority: string
          risk_computed_at: string | null
          risk_score: number | null
          source: string | null
          source_ref: string | null
          status: string
          tags: string[] | null
          title: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          conversation_id?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          metadata?: Json | null
          org_id: string
          owner_id?: string | null
          priority?: string
          risk_computed_at?: string | null
          risk_score?: number | null
          source?: string | null
          source_ref?: string | null
          status?: string
          tags?: string[] | null
          title: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          conversation_id?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          metadata?: Json | null
          org_id?: string
          owner_id?: string | null
          priority?: string
          risk_computed_at?: string | null
          risk_score?: number | null
          source?: string | null
          source_ref?: string | null
          status?: string
          tags?: string[] | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "commitments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitments_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contradiction_resolutions: {
        Row: {
          chosen_truth: Json
          contradiction_id: string
          created_at: string
          id: string
          org_id: string
          rationale: string | null
          resolution_source: string
          resolver_id: string | null
        }
        Insert: {
          chosen_truth: Json
          contradiction_id: string
          created_at?: string
          id?: string
          org_id: string
          rationale?: string | null
          resolution_source: string
          resolver_id?: string | null
        }
        Update: {
          chosen_truth?: Json
          contradiction_id?: string
          created_at?: string
          id?: string
          org_id?: string
          rationale?: string | null
          resolution_source?: string
          resolver_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contradiction_resolutions_contradiction_id_fkey"
            columns: ["contradiction_id"]
            isOneToOne: false
            referencedRelation: "graph_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contradiction_resolutions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contradiction_resolutions_resolver_id_fkey"
            columns: ["resolver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          archived_at: string | null
          created_at: string
          id: string
          metadata: Json | null
          org_id: string
          pinned: boolean
          session_id: string | null
          status: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          org_id: string
          pinned?: boolean
          session_id?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          org_id?: string
          pinned?: boolean
          session_id?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_cards: {
        Row: {
          chosen_action: string
          confidence: number
          context_summary: string | null
          conversation_id: string | null
          created_at: string
          hypotheses: Json | null
          id: string
          latency_ms: number | null
          model_used: string | null
          objective: string
          options_considered: Json | null
          org_id: string
          outcome_id: string | null
          reasoning_tokens: number | null
          related_entity_ids: string[]
          related_insight_ids: string[]
          risk_notes: string | null
          run_id: string | null
          trigger_source: string | null
          trigger_type: string
          updated_at: string
          why_now: string | null
        }
        Insert: {
          chosen_action: string
          confidence?: number
          context_summary?: string | null
          conversation_id?: string | null
          created_at?: string
          hypotheses?: Json | null
          id?: string
          latency_ms?: number | null
          model_used?: string | null
          objective: string
          options_considered?: Json | null
          org_id: string
          outcome_id?: string | null
          reasoning_tokens?: number | null
          related_entity_ids?: string[]
          related_insight_ids?: string[]
          risk_notes?: string | null
          run_id?: string | null
          trigger_source?: string | null
          trigger_type: string
          updated_at?: string
          why_now?: string | null
        }
        Update: {
          chosen_action?: string
          confidence?: number
          context_summary?: string | null
          conversation_id?: string | null
          created_at?: string
          hypotheses?: Json | null
          id?: string
          latency_ms?: number | null
          model_used?: string | null
          objective?: string
          options_considered?: Json | null
          org_id?: string
          outcome_id?: string | null
          reasoning_tokens?: number | null
          related_entity_ids?: string[]
          related_insight_ids?: string[]
          risk_notes?: string | null
          run_id?: string | null
          trigger_source?: string | null
          trigger_type?: string
          updated_at?: string
          why_now?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "decision_cards_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_cards_outcome_id_fkey"
            columns: ["outcome_id"]
            isOneToOne: false
            referencedRelation: "outcomes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_cards_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "outcome_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_outcomes: {
        Row: {
          accuracy_score: number | null
          actual_result: string | null
          created_at: string
          decision_payload: Json
          decision_rationale: string | null
          decision_type: string
          evaluate_after: string
          evaluated_at: string | null
          evaluation_method: string | null
          id: string
          lease_id: string | null
          org_id: string
          prediction: string | null
          prediction_confidence: number | null
          risk_score: number | null
          target_id: string | null
          target_type: string | null
          updated_at: string
        }
        Insert: {
          accuracy_score?: number | null
          actual_result?: string | null
          created_at?: string
          decision_payload?: Json
          decision_rationale?: string | null
          decision_type: string
          evaluate_after: string
          evaluated_at?: string | null
          evaluation_method?: string | null
          id?: string
          lease_id?: string | null
          org_id: string
          prediction?: string | null
          prediction_confidence?: number | null
          risk_score?: number | null
          target_id?: string | null
          target_type?: string | null
          updated_at?: string
        }
        Update: {
          accuracy_score?: number | null
          actual_result?: string | null
          created_at?: string
          decision_payload?: Json
          decision_rationale?: string | null
          decision_type?: string
          evaluate_after?: string
          evaluated_at?: string | null
          evaluation_method?: string | null
          id?: string
          lease_id?: string | null
          org_id?: string
          prediction?: string | null
          prediction_confidence?: number | null
          risk_score?: number | null
          target_id?: string | null
          target_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "decision_outcomes_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "chief_loop_leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_outcomes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      entities: {
        Row: {
          access_count: number
          attributes: Json | null
          canonical_name: string
          created_at: string
          description: string | null
          embedding: string | null
          entity_type: string
          first_seen_at: string
          id: string
          is_pinned: boolean
          last_accessed_at: string | null
          last_decay_at: string | null
          last_seen_at: string
          memory_class: string
          mention_count: number
          name: string
          org_id: string
          state: string
          updated_at: string
          utility_score: number
        }
        Insert: {
          access_count?: number
          attributes?: Json | null
          canonical_name: string
          created_at?: string
          description?: string | null
          embedding?: string | null
          entity_type: string
          first_seen_at?: string
          id?: string
          is_pinned?: boolean
          last_accessed_at?: string | null
          last_decay_at?: string | null
          last_seen_at?: string
          memory_class?: string
          mention_count?: number
          name: string
          org_id: string
          state?: string
          updated_at?: string
          utility_score?: number
        }
        Update: {
          access_count?: number
          attributes?: Json | null
          canonical_name?: string
          created_at?: string
          description?: string | null
          embedding?: string | null
          entity_type?: string
          first_seen_at?: string
          id?: string
          is_pinned?: boolean
          last_accessed_at?: string | null
          last_decay_at?: string | null
          last_seen_at?: string
          memory_class?: string
          mention_count?: number
          name?: string
          org_id?: string
          state?: string
          updated_at?: string
          utility_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "entities_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_relationships: {
        Row: {
          confidence: number
          created_at: string
          id: string
          org_id: string
          properties: Json | null
          relationship_type: string
          source_conversation_id: string | null
          source_entity_id: string
          target_entity_id: string
          updated_at: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          id?: string
          org_id: string
          properties?: Json | null
          relationship_type: string
          source_conversation_id?: string | null
          source_entity_id: string
          target_entity_id: string
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          id?: string
          org_id?: string
          properties?: Json | null
          relationship_type?: string
          source_conversation_id?: string | null
          source_entity_id?: string
          target_entity_id?: string
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "entity_relationships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_relationships_source_conversation_id_fkey"
            columns: ["source_conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_relationships_source_entity_id_fkey"
            columns: ["source_entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_relationships_target_entity_id_fkey"
            columns: ["target_entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_jobs: {
        Row: {
          completed_at: string | null
          conversation_id: string | null
          cost_usd: number | null
          created_at: string
          duration_ms: number | null
          embeddings_generated: number | null
          entities_extracted: number | null
          error: string | null
          id: string
          message_id: string | null
          model_used: string | null
          org_id: string
          relationships_extracted: number | null
          status: string
          tokens_used: Json | null
        }
        Insert: {
          completed_at?: string | null
          conversation_id?: string | null
          cost_usd?: number | null
          created_at?: string
          duration_ms?: number | null
          embeddings_generated?: number | null
          entities_extracted?: number | null
          error?: string | null
          id?: string
          message_id?: string | null
          model_used?: string | null
          org_id: string
          relationships_extracted?: number | null
          status?: string
          tokens_used?: Json | null
        }
        Update: {
          completed_at?: string | null
          conversation_id?: string | null
          cost_usd?: number | null
          created_at?: string
          duration_ms?: number | null
          embeddings_generated?: number | null
          entities_extracted?: number | null
          error?: string | null
          id?: string
          message_id?: string | null
          model_used?: string | null
          org_id?: string
          relationships_extracted?: number | null
          status?: string
          tokens_used?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "extraction_jobs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_jobs_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_signals: {
        Row: {
          category: string | null
          created_at: string
          id: string
          metadata: Json | null
          org_id: string
          signal_type: string
          source_id: string
          source_type: string
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          org_id: string
          signal_type: string
          source_id: string
          source_type: string
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          org_id?: string
          signal_type?: string
          source_id?: string
          source_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_signals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_signals_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      graph_insights: {
        Row: {
          action_template: Json | null
          category: string | null
          confidence: number
          created_at: string
          evidence: Json
          expires_at: string
          id: string
          idempotency_key: string
          insight_type: string
          last_triggered_at: string
          org_id: string
          related_entity_ids: string[]
          routed_finding_id: string | null
          source_conversation_id: string | null
          status: string
          summary: string
          superseded_by: string | null
          times_triggered: number
          updated_at: string
          utility_score: number
        }
        Insert: {
          action_template?: Json | null
          category?: string | null
          confidence?: number
          created_at?: string
          evidence?: Json
          expires_at?: string
          id?: string
          idempotency_key: string
          insight_type: string
          last_triggered_at?: string
          org_id: string
          related_entity_ids?: string[]
          routed_finding_id?: string | null
          source_conversation_id?: string | null
          status?: string
          summary: string
          superseded_by?: string | null
          times_triggered?: number
          updated_at?: string
          utility_score?: number
        }
        Update: {
          action_template?: Json | null
          category?: string | null
          confidence?: number
          created_at?: string
          evidence?: Json
          expires_at?: string
          id?: string
          idempotency_key?: string
          insight_type?: string
          last_triggered_at?: string
          org_id?: string
          related_entity_ids?: string[]
          routed_finding_id?: string | null
          source_conversation_id?: string | null
          status?: string
          summary?: string
          superseded_by?: string | null
          times_triggered?: number
          updated_at?: string
          utility_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "graph_insights_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "graph_insights_routed_finding_id_fkey"
            columns: ["routed_finding_id"]
            isOneToOne: false
            referencedRelation: "patrol_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "graph_insights_source_conversation_id_fkey"
            columns: ["source_conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "graph_insights_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "graph_insights"
            referencedColumns: ["id"]
          },
        ]
      }
      insight_actions: {
        Row: {
          action_id: string | null
          created_at: string
          decision_mode: string
          execution_result: string
          finding_id: string | null
          id: string
          insight_id: string
          org_id: string
          outcome_notes: string | null
          policy_path: string | null
          resolved_at: string | null
        }
        Insert: {
          action_id?: string | null
          created_at?: string
          decision_mode: string
          execution_result?: string
          finding_id?: string | null
          id?: string
          insight_id: string
          org_id: string
          outcome_notes?: string | null
          policy_path?: string | null
          resolved_at?: string | null
        }
        Update: {
          action_id?: string | null
          created_at?: string
          decision_mode?: string
          execution_result?: string
          finding_id?: string | null
          id?: string
          insight_id?: string
          org_id?: string
          outcome_notes?: string | null
          policy_path?: string | null
          resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "insight_actions_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insight_actions_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "patrol_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insight_actions_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "graph_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insight_actions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_permissions: {
        Row: {
          created_at: string
          description: string | null
          display_name: string
          id: string
          integration_id: string
          is_mandatory: boolean
          scope: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          display_name: string
          id?: string
          integration_id: string
          is_mandatory?: boolean
          scope: string
        }
        Update: {
          created_at?: string
          description?: string | null
          display_name?: string
          id?: string
          integration_id?: string
          is_mandatory?: boolean
          scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_permissions_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          auth_type: string
          category: string
          created_at: string
          description: string | null
          display_order: number
          id: string
          instructions: Json | null
          key: string
          logo_url: string | null
          manifest: Json | null
          name: string
          parent_integration_id: string | null
          status: string
          updated_at: string
          vendor: string
        }
        Insert: {
          auth_type: string
          category: string
          created_at?: string
          description?: string | null
          display_order?: number
          id?: string
          instructions?: Json | null
          key: string
          logo_url?: string | null
          manifest?: Json | null
          name: string
          parent_integration_id?: string | null
          status?: string
          updated_at?: string
          vendor: string
        }
        Update: {
          auth_type?: string
          category?: string
          created_at?: string
          description?: string | null
          display_order?: number
          id?: string
          instructions?: Json | null
          key?: string
          logo_url?: string | null
          manifest?: Json | null
          name?: string
          parent_integration_id?: string | null
          status?: string
          updated_at?: string
          vendor?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_parent_integration_id_fkey"
            columns: ["parent_integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      intervention_feedback: {
        Row: {
          created_at: string
          id: string
          intervention_summary: string
          intervention_type: string
          org_id: string
          responded_at: string | null
          response_latency_ms: number | null
          source_category: string | null
          triage_id: string | null
          user_id: string
          user_response: string
        }
        Insert: {
          created_at?: string
          id?: string
          intervention_summary: string
          intervention_type: string
          org_id: string
          responded_at?: string | null
          response_latency_ms?: number | null
          source_category?: string | null
          triage_id?: string | null
          user_id: string
          user_response: string
        }
        Update: {
          created_at?: string
          id?: string
          intervention_summary?: string
          intervention_type?: string
          org_id?: string
          responded_at?: string | null
          response_latency_ms?: number | null
          source_category?: string | null
          triage_id?: string | null
          user_id?: string
          user_response?: string
        }
        Relationships: [
          {
            foreignKeyName: "intervention_feedback_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intervention_feedback_triage_id_fkey"
            columns: ["triage_id"]
            isOneToOne: false
            referencedRelation: "intervention_triage"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intervention_feedback_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      intervention_triage: {
        Row: {
          confidence: number
          created_at: string
          finding_id: string | null
          id: string
          org_id: string
          recommended_channel: string | null
          routed_to: string | null
          scoring_rationale: string | null
          source_id: string | null
          source_summary: string
          source_type: string
          timing_sensitivity: string | null
          triage_decision: string
          user_id: string
          user_impact: string | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          finding_id?: string | null
          id?: string
          org_id: string
          recommended_channel?: string | null
          routed_to?: string | null
          scoring_rationale?: string | null
          source_id?: string | null
          source_summary: string
          source_type: string
          timing_sensitivity?: string | null
          triage_decision: string
          user_id: string
          user_impact?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          finding_id?: string | null
          id?: string
          org_id?: string
          recommended_channel?: string | null
          routed_to?: string | null
          scoring_rationale?: string | null
          source_id?: string | null
          source_summary?: string
          source_type?: string
          timing_sensitivity?: string | null
          triage_decision?: string
          user_id?: string
          user_impact?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "intervention_triage_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "patrol_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intervention_triage_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intervention_triage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_action_items: {
        Row: {
          action: string
          commitment_id: string | null
          context_quote: string | null
          context_timestamp: number | null
          created_at: string | null
          due_date: string | null
          id: string
          meeting_id: string
          org_id: string
          owner_email: string | null
          owner_name: string | null
          priority: string | null
          status: string | null
        }
        Insert: {
          action: string
          commitment_id?: string | null
          context_quote?: string | null
          context_timestamp?: number | null
          created_at?: string | null
          due_date?: string | null
          id?: string
          meeting_id: string
          org_id: string
          owner_email?: string | null
          owner_name?: string | null
          priority?: string | null
          status?: string | null
        }
        Update: {
          action?: string
          commitment_id?: string | null
          context_quote?: string | null
          context_timestamp?: number | null
          created_at?: string | null
          due_date?: string | null
          id?: string
          meeting_id?: string
          org_id?: string
          owner_email?: string | null
          owner_name?: string | null
          priority?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_action_items_commitment_id_fkey"
            columns: ["commitment_id"]
            isOneToOne: false
            referencedRelation: "commitments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_action_items_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_action_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_bot_config: {
        Row: {
          auto_summarize: boolean | null
          blocklist_patterns: Json | null
          created_at: string | null
          enable_diarization: boolean | null
          enabled: boolean | null
          excluded_calendars: Json | null
          id: string
          join_mode: string | null
          language: string | null
          min_attendees: number | null
          notify_via_email: boolean | null
          notify_via_slack: boolean | null
          org_id: string
          record_label: string | null
          summarization_model: string | null
          transcription_engine: string | null
          updated_at: string | null
        }
        Insert: {
          auto_summarize?: boolean | null
          blocklist_patterns?: Json | null
          created_at?: string | null
          enable_diarization?: boolean | null
          enabled?: boolean | null
          excluded_calendars?: Json | null
          id?: string
          join_mode?: string | null
          language?: string | null
          min_attendees?: number | null
          notify_via_email?: boolean | null
          notify_via_slack?: boolean | null
          org_id: string
          record_label?: string | null
          summarization_model?: string | null
          transcription_engine?: string | null
          updated_at?: string | null
        }
        Update: {
          auto_summarize?: boolean | null
          blocklist_patterns?: Json | null
          created_at?: string | null
          enable_diarization?: boolean | null
          enabled?: boolean | null
          excluded_calendars?: Json | null
          id?: string
          join_mode?: string | null
          language?: string | null
          min_attendees?: number | null
          notify_via_email?: boolean | null
          notify_via_slack?: boolean | null
          org_id?: string
          record_label?: string | null
          summarization_model?: string | null
          transcription_engine?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_bot_config_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_decisions: {
        Row: {
          context_quote: string | null
          context_timestamp: number | null
          created_at: string | null
          decided_by: string | null
          decision: string
          id: string
          meeting_id: string
          org_id: string
          rationale: string | null
          stakeholders: Json | null
        }
        Insert: {
          context_quote?: string | null
          context_timestamp?: number | null
          created_at?: string | null
          decided_by?: string | null
          decision: string
          id?: string
          meeting_id: string
          org_id: string
          rationale?: string | null
          stakeholders?: Json | null
        }
        Update: {
          context_quote?: string | null
          context_timestamp?: number | null
          created_at?: string | null
          decided_by?: string | null
          decision?: string
          id?: string
          meeting_id?: string
          org_id?: string
          rationale?: string | null
          stakeholders?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_decisions_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_decisions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_speaker_map: {
        Row: {
          confidence: number | null
          id: string
          meeting_id: string
          participant_email: string | null
          speaker_id: number
          speaker_label: string
        }
        Insert: {
          confidence?: number | null
          id?: string
          meeting_id: string
          participant_email?: string | null
          speaker_id: number
          speaker_label: string
        }
        Update: {
          confidence?: number | null
          id?: string
          meeting_id?: string
          participant_email?: string | null
          speaker_id?: number
          speaker_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_speaker_map_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_summaries: {
        Row: {
          cost_usd: number | null
          created_at: string | null
          detailed_summary: string | null
          executive_summary: string | null
          id: string
          meeting_id: string
          model_used: string | null
          org_id: string
          processing_time_ms: number | null
          raw_llm_response: Json | null
          tldr: string | null
          tokens_used: Json | null
          topics: Json | null
        }
        Insert: {
          cost_usd?: number | null
          created_at?: string | null
          detailed_summary?: string | null
          executive_summary?: string | null
          id?: string
          meeting_id: string
          model_used?: string | null
          org_id: string
          processing_time_ms?: number | null
          raw_llm_response?: Json | null
          tldr?: string | null
          tokens_used?: Json | null
          topics?: Json | null
        }
        Update: {
          cost_usd?: number | null
          created_at?: string | null
          detailed_summary?: string | null
          executive_summary?: string | null
          id?: string
          meeting_id?: string
          model_used?: string | null
          org_id?: string
          processing_time_ms?: number | null
          raw_llm_response?: Json | null
          tldr?: string | null
          tokens_used?: Json | null
          topics?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_summaries_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_summaries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          actual_end: string | null
          actual_start: string | null
          bot_rule_applied: Json | null
          bot_session_id: string | null
          calendar_event_id: string | null
          calendar_provider: string | null
          created_at: string | null
          duration_seconds: number | null
          error_message: string | null
          id: string
          meeting_url: string | null
          org_id: string
          organizer_email: string | null
          participants: Json | null
          platform: string | null
          recording_format: string | null
          recording_path: string | null
          recording_size_bytes: number | null
          retry_count: number | null
          scheduled_end: string | null
          scheduled_start: string | null
          skip_reason: string | null
          status: string
          summary_ready: boolean | null
          title: string
          transcript_ready: boolean | null
          updated_at: string | null
          workspace_id: string | null
        }
        Insert: {
          actual_end?: string | null
          actual_start?: string | null
          bot_rule_applied?: Json | null
          bot_session_id?: string | null
          calendar_event_id?: string | null
          calendar_provider?: string | null
          created_at?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          id?: string
          meeting_url?: string | null
          org_id: string
          organizer_email?: string | null
          participants?: Json | null
          platform?: string | null
          recording_format?: string | null
          recording_path?: string | null
          recording_size_bytes?: number | null
          retry_count?: number | null
          scheduled_end?: string | null
          scheduled_start?: string | null
          skip_reason?: string | null
          status?: string
          summary_ready?: boolean | null
          title: string
          transcript_ready?: boolean | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Update: {
          actual_end?: string | null
          actual_start?: string | null
          bot_rule_applied?: Json | null
          bot_session_id?: string | null
          calendar_event_id?: string | null
          calendar_provider?: string | null
          created_at?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          id?: string
          meeting_url?: string | null
          org_id?: string
          organizer_email?: string | null
          participants?: Json | null
          platform?: string | null
          recording_format?: string | null
          recording_path?: string | null
          recording_size_bytes?: number | null
          retry_count?: number | null
          scheduled_end?: string | null
          scheduled_start?: string | null
          skip_reason?: string | null
          status?: string
          summary_ready?: boolean | null
          title?: string
          transcript_ready?: boolean | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meetings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memory: {
        Row: {
          category: string
          confidence: number
          content: string
          created_at: string
          event_date: string | null
          expires_at: string | null
          id: string
          org_id: string
          related_entities: string[] | null
          source: string | null
          subject: string
          updated_at: string
        }
        Insert: {
          category: string
          confidence?: number
          content: string
          created_at?: string
          event_date?: string | null
          expires_at?: string | null
          id?: string
          org_id: string
          related_entities?: string[] | null
          source?: string | null
          subject: string
          updated_at?: string
        }
        Update: {
          category?: string
          confidence?: number
          content?: string
          created_at?: string
          event_date?: string | null
          expires_at?: string | null
          id?: string
          org_id?: string
          related_entities?: string[] | null
          source?: string | null
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_curation_log: {
        Row: {
          action: string
          created_at: string
          id: string
          org_id: string
          rationale: string | null
          score_after: number | null
          score_before: number | null
          target_id: string
          target_type: string
          triggered_by: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          org_id: string
          rationale?: string | null
          score_after?: number | null
          score_before?: number | null
          target_id: string
          target_type: string
          triggered_by: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          org_id?: string
          rationale?: string | null
          score_after?: number | null
          score_before?: number | null
          target_id?: string
          target_type?: string
          triggered_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_curation_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_embeddings: {
        Row: {
          created_at: string
          embedding: string
          id: string
          memory_id: string
          model: string
        }
        Insert: {
          created_at?: string
          embedding: string
          id?: string
          memory_id: string
          model?: string
        }
        Update: {
          created_at?: string
          embedding?: string
          id?: string
          memory_id?: string
          model?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_embeddings_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: true
            referencedRelation: "memory"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_entity_links: {
        Row: {
          entity_id: string
          id: string
          memory_id: string
        }
        Insert: {
          entity_id: string
          id?: string
          memory_id: string
        }
        Update: {
          entity_id?: string
          id?: string
          memory_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_entity_links_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_entity_links_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memory"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_utility_events: {
        Row: {
          conversation_id: string | null
          created_at: string
          entity_id: string | null
          event_type: string
          id: string
          insight_id: string | null
          memory_id: string | null
          org_id: string
          source_channel: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          entity_id?: string | null
          event_type: string
          id?: string
          insight_id?: string | null
          memory_id?: string | null
          org_id: string
          source_channel?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          entity_id?: string | null
          event_type?: string
          id?: string
          insight_id?: string | null
          memory_id?: string | null
          org_id?: string
          source_channel?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memory_utility_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_utility_events_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_utility_events_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "graph_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_utility_events_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_utility_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          metadata: Json | null
          parts: Json | null
          role: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          metadata?: Json | null
          parts?: Json | null
          role: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          parts?: Json | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      nudges: {
        Row: {
          action_id: string | null
          batch_id: string | null
          commitment_id: string | null
          content: string
          created_at: string
          id: string
          org_id: string
          priority: string
          sent_at: string | null
          source_finding_id: string | null
          status: string
          title: string
          type: string
          urgency_score: number | null
          user_id: string
        }
        Insert: {
          action_id?: string | null
          batch_id?: string | null
          commitment_id?: string | null
          content: string
          created_at?: string
          id?: string
          org_id: string
          priority?: string
          sent_at?: string | null
          source_finding_id?: string | null
          status?: string
          title: string
          type: string
          urgency_score?: number | null
          user_id: string
        }
        Update: {
          action_id?: string | null
          batch_id?: string | null
          commitment_id?: string | null
          content?: string
          created_at?: string
          id?: string
          org_id?: string
          priority?: string
          sent_at?: string | null
          source_finding_id?: string | null
          status?: string
          title?: string
          type?: string
          urgency_score?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "nudges_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudges_commitment_id_fkey"
            columns: ["commitment_id"]
            isOneToOne: false
            referencedRelation: "commitments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudges_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudges_source_finding_id_fkey"
            columns: ["source_finding_id"]
            isOneToOne: false
            referencedRelation: "patrol_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_state: {
        Row: {
          completed_at: string | null
          created_at: string
          current_step: number
          id: string
          is_complete: boolean
          org_id: string
          steps: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_step?: number
          id?: string
          is_complete?: boolean
          org_id: string
          steps?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_step?: number
          id?: string
          is_complete?: boolean
          org_id?: string
          steps?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_state_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_state_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      org_rollout_config: {
        Row: {
          auto_allowed_actions: string[]
          created_at: string
          id: string
          manual_auto_approved: boolean
          max_error_rate: number
          min_acceptance_rate: number
          min_interactions: number
          mode_changed_at: string | null
          mode_changed_reason: string | null
          org_id: string
          previous_mode: string | null
          rollout_mode: string
          updated_at: string
        }
        Insert: {
          auto_allowed_actions?: string[]
          created_at?: string
          id?: string
          manual_auto_approved?: boolean
          max_error_rate?: number
          min_acceptance_rate?: number
          min_interactions?: number
          mode_changed_at?: string | null
          mode_changed_reason?: string | null
          org_id: string
          previous_mode?: string | null
          rollout_mode?: string
          updated_at?: string
        }
        Update: {
          auto_allowed_actions?: string[]
          created_at?: string
          id?: string
          manual_auto_approved?: boolean
          max_error_rate?: number
          min_acceptance_rate?: number
          min_interactions?: number
          mode_changed_at?: string | null
          mode_changed_reason?: string | null
          org_id?: string
          previous_mode?: string | null
          rollout_mode?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_rollout_config_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_integrations: {
        Row: {
          connected_by: string | null
          created_at: string
          disconnected_at: string | null
          failure_error: string | null
          granted_scopes: string[] | null
          health_status: string
          id: string
          integration_id: string
          is_active: boolean
          last_health_check: string | null
          org_id: string
          token_data: Json | null
          token_expires_at: string | null
          updated_at: string
          user_metadata: Json | null
        }
        Insert: {
          connected_by?: string | null
          created_at?: string
          disconnected_at?: string | null
          failure_error?: string | null
          granted_scopes?: string[] | null
          health_status?: string
          id?: string
          integration_id: string
          is_active?: boolean
          last_health_check?: string | null
          org_id: string
          token_data?: Json | null
          token_expires_at?: string | null
          updated_at?: string
          user_metadata?: Json | null
        }
        Update: {
          connected_by?: string | null
          created_at?: string
          disconnected_at?: string | null
          failure_error?: string | null
          granted_scopes?: string[] | null
          health_status?: string
          id?: string
          integration_id?: string
          is_active?: boolean
          last_health_check?: string | null
          org_id?: string
          token_data?: Json | null
          token_expires_at?: string | null
          updated_at?: string
          user_metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_integrations_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_integrations_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_integrations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          domain: string | null
          id: string
          name: string
          settings: Json | null
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          domain?: string | null
          id?: string
          name: string
          settings?: Json | null
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          domain?: string | null
          id?: string
          name?: string
          settings?: Json | null
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      outcome_impact: {
        Row: {
          action_taken_at: string | null
          created_at: string
          decision_card_id: string | null
          entity_id: string | null
          id: string
          impact_notes: string | null
          impact_rating: number | null
          impact_type: string
          insight_id: string | null
          org_id: string
          outcome_achieved_at: string | null
          outcome_id: string
        }
        Insert: {
          action_taken_at?: string | null
          created_at?: string
          decision_card_id?: string | null
          entity_id?: string | null
          id?: string
          impact_notes?: string | null
          impact_rating?: number | null
          impact_type: string
          insight_id?: string | null
          org_id: string
          outcome_achieved_at?: string | null
          outcome_id: string
        }
        Update: {
          action_taken_at?: string | null
          created_at?: string
          decision_card_id?: string | null
          entity_id?: string | null
          id?: string
          impact_notes?: string | null
          impact_rating?: number | null
          impact_type?: string
          insight_id?: string | null
          org_id?: string
          outcome_achieved_at?: string | null
          outcome_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "outcome_impact_decision_card_id_fkey"
            columns: ["decision_card_id"]
            isOneToOne: false
            referencedRelation: "decision_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_impact_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_impact_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "graph_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_impact_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_impact_outcome_id_fkey"
            columns: ["outcome_id"]
            isOneToOne: false
            referencedRelation: "outcomes"
            referencedColumns: ["id"]
          },
        ]
      }
      outcome_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          decision_card_id: string | null
          id: string
          org_id: string
          outcome_id: string
          plan_summary: string | null
          plan_version: number
          replan_reason: string | null
          started_at: string | null
          status: string
          supersedes_run_id: string | null
          trigger_source: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          decision_card_id?: string | null
          id?: string
          org_id: string
          outcome_id: string
          plan_summary?: string | null
          plan_version?: number
          replan_reason?: string | null
          started_at?: string | null
          status?: string
          supersedes_run_id?: string | null
          trigger_source?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          decision_card_id?: string | null
          id?: string
          org_id?: string
          outcome_id?: string
          plan_summary?: string | null
          plan_version?: number
          replan_reason?: string | null
          started_at?: string | null
          status?: string
          supersedes_run_id?: string | null
          trigger_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outcome_runs_decision_card_id_fkey"
            columns: ["decision_card_id"]
            isOneToOne: false
            referencedRelation: "decision_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_runs_outcome_id_fkey"
            columns: ["outcome_id"]
            isOneToOne: false
            referencedRelation: "outcomes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_runs_supersedes_run_id_fkey"
            columns: ["supersedes_run_id"]
            isOneToOne: false
            referencedRelation: "outcome_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      outcome_signal_links: {
        Row: {
          created_at: string | null
          id: string
          link_type: string
          linked_by: string
          org_id: string
          outcome_id: string
          run_id: string | null
          signal_id: string
          signal_type: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          link_type?: string
          linked_by?: string
          org_id: string
          outcome_id: string
          run_id?: string | null
          signal_id: string
          signal_type: string
        }
        Update: {
          created_at?: string | null
          id?: string
          link_type?: string
          linked_by?: string
          org_id?: string
          outcome_id?: string
          run_id?: string | null
          signal_id?: string
          signal_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "outcome_signal_links_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_signal_links_outcome_id_fkey"
            columns: ["outcome_id"]
            isOneToOne: false
            referencedRelation: "outcomes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_signal_links_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "outcome_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      outcome_steps: {
        Row: {
          action_type: string
          approval_id: string | null
          blocker_type: string | null
          completed_at: string | null
          created_at: string
          decision_card_id: string | null
          depends_on: string[]
          description: string
          error_message: string | null
          expected_output: string | null
          id: string
          one_clear_ask: string | null
          org_id: string
          origin: string | null
          result_data: Json | null
          result_summary: string | null
          risk_class: string | null
          risk_score: number | null
          run_id: string
          started_at: string | null
          status: string
          step_order: number
          tool_args: Json | null
          tool_name: string | null
        }
        Insert: {
          action_type: string
          approval_id?: string | null
          blocker_type?: string | null
          completed_at?: string | null
          created_at?: string
          decision_card_id?: string | null
          depends_on?: string[]
          description: string
          error_message?: string | null
          expected_output?: string | null
          id?: string
          one_clear_ask?: string | null
          org_id: string
          origin?: string | null
          result_data?: Json | null
          result_summary?: string | null
          risk_class?: string | null
          risk_score?: number | null
          run_id: string
          started_at?: string | null
          status?: string
          step_order: number
          tool_args?: Json | null
          tool_name?: string | null
        }
        Update: {
          action_type?: string
          approval_id?: string | null
          blocker_type?: string | null
          completed_at?: string | null
          created_at?: string
          decision_card_id?: string | null
          depends_on?: string[]
          description?: string
          error_message?: string | null
          expected_output?: string | null
          id?: string
          one_clear_ask?: string | null
          org_id?: string
          origin?: string | null
          result_data?: Json | null
          result_summary?: string | null
          risk_class?: string | null
          risk_score?: number | null
          run_id?: string
          started_at?: string | null
          status?: string
          step_order?: number
          tool_args?: Json | null
          tool_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outcome_steps_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "pending_approvals"
            referencedColumns: ["approval_id"]
          },
          {
            foreignKeyName: "outcome_steps_decision_card_id_fkey"
            columns: ["decision_card_id"]
            isOneToOne: false
            referencedRelation: "decision_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_steps_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_steps_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "outcome_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      outcomes: {
        Row: {
          blocker_summary: string | null
          completed_at: string | null
          confidence: number | null
          conversation_id: string | null
          created_at: string
          description: string | null
          goal_type: string
          id: string
          org_id: string
          owner_user_id: string | null
          parent_outcome_id: string | null
          priority: string
          related_entity_ids: string[]
          started_at: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          blocker_summary?: string | null
          completed_at?: string | null
          confidence?: number | null
          conversation_id?: string | null
          created_at?: string
          description?: string | null
          goal_type?: string
          id?: string
          org_id: string
          owner_user_id?: string | null
          parent_outcome_id?: string | null
          priority?: string
          related_entity_ids?: string[]
          started_at?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          blocker_summary?: string | null
          completed_at?: string | null
          confidence?: number | null
          conversation_id?: string | null
          created_at?: string
          description?: string | null
          goal_type?: string
          id?: string
          org_id?: string
          owner_user_id?: string | null
          parent_outcome_id?: string | null
          priority?: string
          related_entity_ids?: string[]
          started_at?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outcomes_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcomes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcomes_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcomes_parent_outcome_id_fkey"
            columns: ["parent_outcome_id"]
            isOneToOne: false
            referencedRelation: "outcomes"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_findings: {
        Row: {
          action_id: string | null
          agentic_scan_id: string | null
          commitment_id: string | null
          created_at: string
          description: string | null
          entity_id: string | null
          expires_at: string | null
          id: string
          memory_id: string | null
          metadata: Json | null
          org_id: string
          resolved_at: string | null
          scan_type: string | null
          severity: string
          source_integrations: string[] | null
          status: string
          title: string
          type: string
        }
        Insert: {
          action_id?: string | null
          agentic_scan_id?: string | null
          commitment_id?: string | null
          created_at?: string
          description?: string | null
          entity_id?: string | null
          expires_at?: string | null
          id?: string
          memory_id?: string | null
          metadata?: Json | null
          org_id: string
          resolved_at?: string | null
          scan_type?: string | null
          severity: string
          source_integrations?: string[] | null
          status?: string
          title: string
          type: string
        }
        Update: {
          action_id?: string | null
          agentic_scan_id?: string | null
          commitment_id?: string | null
          created_at?: string
          description?: string | null
          entity_id?: string | null
          expires_at?: string | null
          id?: string
          memory_id?: string | null
          metadata?: Json | null
          org_id?: string
          resolved_at?: string | null
          scan_type?: string | null
          severity?: string
          source_integrations?: string[] | null
          status?: string
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "patrol_findings_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_findings_commitment_id_fkey"
            columns: ["commitment_id"]
            isOneToOne: false
            referencedRelation: "commitments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_findings_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_findings_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_findings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_approvals: {
        Row: {
          approval_id: string
          conversation_id: string
          created_at: string
          decision_rationale: string | null
          decision_type: string | null
          expires_at: string
          org_id: string
          resolved_at: string | null
          risk_score: number | null
          source: string | null
          status: string
          tool_input: Json
          tool_name: string
        }
        Insert: {
          approval_id: string
          conversation_id: string
          created_at?: string
          decision_rationale?: string | null
          decision_type?: string | null
          expires_at: string
          org_id: string
          resolved_at?: string | null
          risk_score?: number | null
          source?: string | null
          status?: string
          tool_input?: Json
          tool_name: string
        }
        Update: {
          approval_id?: string
          conversation_id?: string
          created_at?: string
          decision_rationale?: string | null
          decision_type?: string | null
          expires_at?: string
          org_id?: string
          resolved_at?: string | null
          risk_score?: number | null
          source?: string | null
          status?: string
          tool_input?: Json
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_approvals_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      procedural_memory: {
        Row: {
          context_tags: string[] | null
          created_at: string | null
          embedding: string | null
          failure_count: number | null
          id: string
          last_applied_at: string | null
          org_id: string
          success_count: number | null
          successful_approach: string
          trigger_pattern: string
          updated_at: string | null
        }
        Insert: {
          context_tags?: string[] | null
          created_at?: string | null
          embedding?: string | null
          failure_count?: number | null
          id?: string
          last_applied_at?: string | null
          org_id: string
          success_count?: number | null
          successful_approach: string
          trigger_pattern: string
          updated_at?: string | null
        }
        Update: {
          context_tags?: string[] | null
          created_at?: string | null
          embedding?: string | null
          failure_count?: number | null
          id?: string
          last_applied_at?: string | null
          org_id?: string
          success_count?: number | null
          successful_approach?: string
          trigger_pattern?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "procedural_memory_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          communication_style: string
          created_at: string
          email: string
          full_name: string
          id: string
          notification_channel: string
          onboarded_at: string | null
          org_id: string
          role: string
          settings: Json | null
          slack_user_id: string | null
          timezone: string
          title: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          communication_style?: string
          created_at?: string
          email: string
          full_name: string
          id: string
          notification_channel?: string
          onboarded_at?: string | null
          org_id: string
          role?: string
          settings?: Json | null
          slack_user_id?: string | null
          timezone?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          communication_style?: string
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          notification_channel?: string
          onboarded_at?: string | null
          org_id?: string
          role?: string
          settings?: Json | null
          slack_user_id?: string | null
          timezone?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      rollout_measurement: {
        Row: {
          acceptance_rate: number | null
          accepted_recommendations: number
          avg_decision_confidence: number | null
          completed_outcomes: number
          created_at: string
          error_rate: number | null
          escalation_count: number
          failed_actions: number
          failed_outcomes: number
          id: string
          interventions_accepted: number
          interventions_ignored: number
          interventions_rejected: number
          measurement_week: string
          org_id: string
          outcome_impact_score: number | null
          recommendation_reason: string | null
          recommended_mode: string | null
          rejected_recommendations: number
          successful_actions: number
          total_actions: number
          total_decisions: number
          total_outcomes: number
          total_recommendations: number
        }
        Insert: {
          acceptance_rate?: number | null
          accepted_recommendations?: number
          avg_decision_confidence?: number | null
          completed_outcomes?: number
          created_at?: string
          error_rate?: number | null
          escalation_count?: number
          failed_actions?: number
          failed_outcomes?: number
          id?: string
          interventions_accepted?: number
          interventions_ignored?: number
          interventions_rejected?: number
          measurement_week: string
          org_id: string
          outcome_impact_score?: number | null
          recommendation_reason?: string | null
          recommended_mode?: string | null
          rejected_recommendations?: number
          successful_actions?: number
          total_actions?: number
          total_decisions?: number
          total_outcomes?: number
          total_recommendations?: number
        }
        Update: {
          acceptance_rate?: number | null
          accepted_recommendations?: number
          avg_decision_confidence?: number | null
          completed_outcomes?: number
          created_at?: string
          error_rate?: number | null
          escalation_count?: number
          failed_actions?: number
          failed_outcomes?: number
          id?: string
          interventions_accepted?: number
          interventions_ignored?: number
          interventions_rejected?: number
          measurement_week?: string
          org_id?: string
          outcome_impact_score?: number | null
          recommendation_reason?: string | null
          recommended_mode?: string | null
          rejected_recommendations?: number
          successful_actions?: number
          total_actions?: number
          total_decisions?: number
          total_outcomes?: number
          total_recommendations?: number
        }
        Relationships: [
          {
            foreignKeyName: "rollout_measurement_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      strategic_narratives: {
        Row: {
          created_at: string
          decision_history: Json
          id: string
          key_facts: Json
          last_updated_by: string | null
          narrative_type: string
          open_questions: Json
          org_id: string
          prior_outcomes: Json
          promotion_score: number
          related_entity_ids: string[]
          related_outcome_ids: string[]
          status: string
          summary: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          decision_history?: Json
          id?: string
          key_facts?: Json
          last_updated_by?: string | null
          narrative_type: string
          open_questions?: Json
          org_id: string
          prior_outcomes?: Json
          promotion_score?: number
          related_entity_ids?: string[]
          related_outcome_ids?: string[]
          status?: string
          summary: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          decision_history?: Json
          id?: string
          key_facts?: Json
          last_updated_by?: string | null
          narrative_type?: string
          open_questions?: Json
          org_id?: string
          prior_outcomes?: Json
          promotion_score?: number
          related_entity_ids?: string[]
          related_outcome_ids?: string[]
          status?: string
          summary?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategic_narratives_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      transcript_segments: {
        Row: {
          confidence: number | null
          created_at: string | null
          end_time: number | null
          id: string
          is_final: boolean | null
          language: string | null
          meeting_id: string
          speaker: string | null
          speaker_id: number | null
          start_time: number | null
          text: string
          word_count: number | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          end_time?: number | null
          id?: string
          is_final?: boolean | null
          language?: string | null
          meeting_id: string
          speaker?: string | null
          speaker_id?: number | null
          start_time?: number | null
          text: string
          word_count?: number | null
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          end_time?: number | null
          id?: string
          is_final?: boolean | null
          language?: string | null
          meeting_id?: string
          speaker?: string | null
          speaker_id?: number | null
          start_time?: number | null
          text?: string
          word_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "transcript_segments_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          confidence: number
          created_at: string
          escalation_preference: string
          id: string
          intervention_timing: string
          learned_at: string | null
          message_style: string
          org_id: string
          risk_tolerance: number
          sample_size: number
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          confidence?: number
          created_at?: string
          escalation_preference?: string
          id?: string
          intervention_timing?: string
          learned_at?: string | null
          message_style?: string
          org_id: string
          risk_tolerance?: number
          sample_size?: number
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          confidence?: number
          created_at?: string
          escalation_preference?: string
          id?: string
          intervention_timing?: string
          learned_at?: string | null
          message_style?: string
          org_id?: string
          risk_tolerance?: number
          sample_size?: number
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_signal_weights: {
        Row: {
          acted_count: number
          category: string
          dismissed_count: number
          id: string
          org_id: string
          total_count: number
          updated_at: string
          user_id: string
          weight: number
        }
        Insert: {
          acted_count?: number
          category: string
          dismissed_count?: number
          id?: string
          org_id: string
          total_count?: number
          updated_at?: string
          user_id: string
          weight?: number
        }
        Update: {
          acted_count?: number
          category?: string
          dismissed_count?: number
          id?: string
          org_id?: string
          total_count?: number
          updated_at?: string
          user_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_signal_weights_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_signal_weights_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_tuning_log: {
        Row: {
          acceptance_rate: number | null
          applied_at: string | null
          approved_changes: Json
          created_at: string
          false_positive_rate: number | null
          guardrail_violations: Json
          id: string
          intervention_accuracy: number | null
          org_id: string
          proposals: Json
          total_interactions: number
          tuning_week: string
        }
        Insert: {
          acceptance_rate?: number | null
          applied_at?: string | null
          approved_changes?: Json
          created_at?: string
          false_positive_rate?: number | null
          guardrail_violations?: Json
          id?: string
          intervention_accuracy?: number | null
          org_id: string
          proposals?: Json
          total_interactions?: number
          tuning_week: string
        }
        Update: {
          acceptance_rate?: number | null
          applied_at?: string | null
          approved_changes?: Json
          created_at?: string
          false_positive_rate?: number | null
          guardrail_violations?: Json
          id?: string
          intervention_accuracy?: number | null
          org_id?: string
          proposals?: Json
          total_interactions?: number
          tuning_week?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_tuning_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_executions: {
        Row: {
          completed_at: string | null
          conversation_id: string | null
          cost_usd: number | null
          created_at: string
          duration_ms: number | null
          error: string | null
          id: string
          input_summary: string | null
          lease_id: string | null
          loop_phase: string | null
          org_id: string
          output_summary: string | null
          status: string
          tokens_used: Json | null
          trigger: string | null
          worker: string
        }
        Insert: {
          completed_at?: string | null
          conversation_id?: string | null
          cost_usd?: number | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          input_summary?: string | null
          lease_id?: string | null
          loop_phase?: string | null
          org_id: string
          output_summary?: string | null
          status?: string
          tokens_used?: Json | null
          trigger?: string | null
          worker: string
        }
        Update: {
          completed_at?: string | null
          conversation_id?: string | null
          cost_usd?: number | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          input_summary?: string | null
          lease_id?: string | null
          loop_phase?: string | null
          org_id?: string
          output_summary?: string | null
          status?: string
          tokens_used?: Json | null
          trigger?: string | null
          worker?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_executions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_executions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      working_memory: {
        Row: {
          accuracy_stats: Json
          attention_items: Json
          created_at: string
          decision_log: Json
          deferred_items: Json
          id: string
          org_id: string
          predictions: Json
          running_summary: string
          updated_at: string
          version: number
        }
        Insert: {
          accuracy_stats?: Json
          attention_items?: Json
          created_at?: string
          decision_log?: Json
          deferred_items?: Json
          id?: string
          org_id: string
          predictions?: Json
          running_summary?: string
          updated_at?: string
          version?: number
        }
        Update: {
          accuracy_stats?: Json
          attention_items?: Json
          created_at?: string
          decision_log?: Json
          deferred_items?: Json
          id?: string
          org_id?: string
          predictions?: Json
          running_summary?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "working_memory_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_decay_cycle: {
        Args: { p_org_id: string }
        Returns: {
          transitioned_to_archived: number
          transitioned_to_dormant: number
        }[]
      }
      bump_entity_access: {
        Args: { p_entity_ids: string[]; p_org_id: string }
        Returns: undefined
      }
      compute_rollout_metrics: {
        Args: { p_org_id: string; p_week_start: string }
        Returns: {
          acceptance_rate: number
          avg_confidence: number
          completed_outcomes: number
          error_rate: number
          failed_outcomes: number
          total_decisions: number
          total_outcomes: number
        }[]
      }
      detect_velocity_spikes: {
        Args: { p_org_id: string; p_spike_threshold?: number }
        Returns: {
          avg_30d_weekly: number
          entity_id: string
          entity_name: string
          entity_type: string
          recent_7d_count: number
          spike_ratio: number
        }[]
      }
      find_co_occurring_entities: {
        Args: {
          p_limit?: number
          p_min_co_occurrences?: number
          p_org_id: string
        }
        Returns: {
          co_occurrence_count: number
          entity_a_id: string
          entity_a_name: string
          entity_b_id: string
          entity_b_name: string
          relationship_types: string[]
        }[]
      }
      find_repetitive_relationships: {
        Args: { p_min_repetitions?: number; p_org_id: string }
        Returns: {
          avg_confidence: number
          conversation_ids: string[]
          earliest: string
          latest: string
          relationship_type: string
          repetition_count: number
          source_entity_id: string
          source_entity_name: string
          target_entity_id: string
          target_entity_name: string
        }[]
      }
      get_active_outcomes: {
        Args: { p_limit?: number; p_org_id: string }
        Returns: {
          blocker_summary: string | null
          completed_at: string | null
          confidence: number | null
          conversation_id: string | null
          created_at: string
          description: string | null
          goal_type: string
          id: string
          org_id: string
          owner_user_id: string | null
          parent_outcome_id: string | null
          priority: string
          related_entity_ids: string[]
          started_at: string | null
          status: string
          title: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "outcomes"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_decision_cards_for_conversation: {
        Args: { p_conversation_id: string; p_limit?: number; p_org_id: string }
        Returns: {
          chosen_action: string
          confidence: number
          context_summary: string | null
          conversation_id: string | null
          created_at: string
          hypotheses: Json | null
          id: string
          latency_ms: number | null
          model_used: string | null
          objective: string
          options_considered: Json | null
          org_id: string
          outcome_id: string | null
          reasoning_tokens: number | null
          related_entity_ids: string[]
          related_insight_ids: string[]
          risk_notes: string | null
          run_id: string | null
          trigger_source: string | null
          trigger_type: string
          updated_at: string
          why_now: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "decision_cards"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_entity_neighborhood: {
        Args: {
          p_active_only?: boolean
          p_entity_id: string
          p_max_hops?: number
          p_org_id: string
        }
        Returns: {
          entity_description: string
          entity_id: string
          entity_name: string
          entity_type: string
          hop_distance: number
          relationship_direction: string
          relationship_properties: Json
          relationship_type: string
          valid_from: string
          valid_to: string
        }[]
      }
      get_entity_timeline: {
        Args: { p_entity_id: string; p_org_id: string; p_since?: string }
        Returns: {
          event_time: string
          event_type: string
          properties: Json
          related_entity_name: string
          related_entity_type: string
          relationship_type: string
          valid_to: string
        }[]
      }
      get_intervention_history: {
        Args: {
          p_days?: number
          p_org_id: string
          p_source_category?: string
          p_user_id: string
        }
        Returns: {
          acceptance_rate: number
          accepted_count: number
          ignored_count: number
          intervention_type: string
          last_intervention_at: string
          rejected_count: number
          total_count: number
        }[]
      }
      get_relevant_entities: {
        Args: { p_limit?: number; p_min_relevance?: number; p_org_id: string }
        Returns: {
          entity_description: string
          entity_id: string
          entity_name: string
          entity_state: string
          entity_type: string
          is_entity_pinned: boolean
          memory_cls: string
          mention_count: number
          relevance_score: number
          utility: number
        }[]
      }
      merge_entity: {
        Args: { keep_id: string; merge_id: string }
        Returns: undefined
      }
      release_chief_lease:
        | {
            Args: {
              p_cost_usd?: number
              p_lease_id: string
              p_outcomes_created?: number
              p_result_summary?: string
              p_signals_ingested?: number
              p_status?: string
              p_steps_executed?: number
            }
            Returns: undefined
          }
        | {
            Args: {
              p_carry_forward?: string
              p_cost_usd?: number
              p_lease_id: string
              p_outcomes_created?: number
              p_result_summary?: string
              p_signals_ingested?: number
              p_status?: string
              p_steps_executed?: number
            }
            Returns: undefined
          }
      search_entities_by_embedding: {
        Args: {
          p_embedding: string
          p_limit?: number
          p_min_similarity?: number
          p_org_id: string
        }
        Returns: {
          canonical_name: string
          entity_description: string
          entity_id: string
          entity_name: string
          entity_state: string
          entity_type: string
          mention_count: number
          similarity: number
          utility: number
        }[]
      }
      search_memories_by_embedding: {
        Args: {
          p_category?: string
          p_embedding: string
          p_limit?: number
          p_org_id: string
        }
        Returns: {
          category: string
          confidence: number
          content: string
          created_at: string
          memory_id: string
          related_entities: string[]
          similarity: number
          subject: string
        }[]
      }
      try_acquire_chief_lease: {
        Args: { p_org_id: string; p_ttl_minutes?: number }
        Returns: string
      }
      upsert_insight_with_dedupe: {
        Args: {
          p_action_template?: Json
          p_category?: string
          p_confidence?: number
          p_entity_ids?: string[]
          p_evidence?: Json
          p_idempotency_key: string
          p_insight_type: string
          p_org_id: string
          p_source_conversation_id?: string
          p_summary?: string
        }
        Returns: string
      }
      user_org_id: { Args: never; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
