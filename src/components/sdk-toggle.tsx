'use client'

import { useState, useEffect, useCallback } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type AgentSDK = 'claude' | 'openai'

interface SDKToggleProps {
  /** Compact mode for the chat input bar (pill-style). Full mode for settings page. */
  variant?: 'compact' | 'full'
  /** Optional callback when SDK changes */
  onChange?: (sdk: AgentSDK) => void
}

export function SDKToggle({ variant = 'compact', onChange }: SDKToggleProps) {
  const [sdk, setSdk] = useState<AgentSDK>('claude')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Load current SDK preference on mount
  useEffect(() => {
    fetch('/api/settings/sdk')
      .then(res => res.json())
      .then(data => {
        if (data.sdk === 'claude' || data.sdk === 'openai') {
          setSdk(data.sdk)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const toggleSdk = useCallback(async () => {
    const newSdk: AgentSDK = sdk === 'claude' ? 'openai' : 'claude'
    setSaving(true)
    try {
      const res = await fetch('/api/settings/sdk', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdk: newSdk }),
      })
      if (res.ok) {
        setSdk(newSdk)
        onChange?.(newSdk)
      }
    } catch {
      // Revert on error
    } finally {
      setSaving(false)
    }
  }, [sdk, onChange])

  const selectSdk = useCallback(async (newSdk: AgentSDK) => {
    if (newSdk === sdk) return
    setSaving(true)
    try {
      const res = await fetch('/api/settings/sdk', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdk: newSdk }),
      })
      if (res.ok) {
        setSdk(newSdk)
        onChange?.(newSdk)
      }
    } catch {
      // Revert on error
    } finally {
      setSaving(false)
    }
  }, [sdk, onChange])

  // ─── Compact variant (pill toggle near chat input) ─────────────────────────
  if (variant === 'compact') {
    if (loading) {
      return (
        <div className="h-6 w-[108px] animate-pulse rounded-full bg-muted" />
      )
    }

    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSdk}
              disabled={saving}
              className="group relative inline-flex h-6 items-center gap-0 rounded-full border border-border/50 bg-muted/50 p-0.5 text-[10px] font-medium transition-all hover:border-border hover:bg-muted disabled:opacity-50"
            >
              {/* Claude option */}
              <span
                className={`relative z-10 flex items-center gap-1 rounded-full px-2 py-0.5 transition-all ${
                  sdk === 'claude'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground'
                }`}
              >
                <ClaudeIcon className="h-3 w-3" />
                Claude
              </span>
              {/* OpenAI option */}
              <span
                className={`relative z-10 flex items-center gap-1 rounded-full px-2 py-0.5 transition-all ${
                  sdk === 'openai'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground'
                }`}
              >
                <OpenAIIcon className="h-3 w-3" />
                OpenAI
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">Switch AI model ({sdk === 'claude' ? 'Claude' : 'OpenAI'})</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // ─── Full variant (settings page) ──────────────────────────────────────────
  if (loading) {
    return <div className="h-10 w-full max-w-xs animate-pulse rounded-lg bg-muted" />
  }

  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => selectSdk('claude')}
        disabled={saving}
        className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all disabled:opacity-50 ${
          sdk === 'claude'
            ? 'border-primary bg-primary/5 text-foreground shadow-sm'
            : 'border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground'
        }`}
      >
        <ClaudeIcon className="h-4 w-4" />
        <div className="text-left">
          <p className="font-medium">Claude</p>
          <p className="text-[10px] text-muted-foreground">Anthropic</p>
        </div>
        {sdk === 'claude' && (
          <span className="ml-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={() => selectSdk('openai')}
        disabled={saving}
        className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all disabled:opacity-50 ${
          sdk === 'openai'
            ? 'border-primary bg-primary/5 text-foreground shadow-sm'
            : 'border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground'
        }`}
      >
        <OpenAIIcon className="h-4 w-4" />
        <div className="text-left">
          <p className="font-medium">OpenAI</p>
          <p className="text-[10px] text-muted-foreground">GPT-4.1</p>
        </div>
        {sdk === 'openai' && (
          <span className="ml-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
        )}
      </button>
    </div>
  )
}

// ─── Minimal brand icons ──────────────────────────────────────────────────────

function ClaudeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M16.28 2.477a1.24 1.24 0 0 0-1.618.674L8.162 18.29a1.24 1.24 0 0 0 .673 1.618 1.24 1.24 0 0 0 1.618-.674l6.5-15.139a1.24 1.24 0 0 0-.674-1.618M7.723 7.12a1.24 1.24 0 0 0-1.618.673L3.04 15.42a1.24 1.24 0 0 0 .674 1.618 1.24 1.24 0 0 0 1.618-.674L8.396 8.74a1.24 1.24 0 0 0-.674-1.618" />
    </svg>
  )
}

function OpenAIIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  )
}
