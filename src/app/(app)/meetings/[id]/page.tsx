'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import {
  ArrowLeft, Mic, Clock, Users, CalendarDays,
  CheckCircle2, AlertCircle, Loader2, ChevronDown,
  ChevronUp, ListChecks, Lightbulb, MessageSquare,
} from 'lucide-react'
import type { MeetingStatus, ActionItemPriority } from '@/types/meetings'

// ─── Types ──────────────────────────────────────────────────────────

interface MeetingDetail {
  id: string
  title: string
  platform: string | null
  scheduled_start: string | null
  scheduled_end: string | null
  actual_start: string | null
  actual_end: string | null
  duration_seconds: number | null
  participants: Array<{ name: string; email: string }>
  status: MeetingStatus
  summary_ready: boolean
  transcript_ready: boolean
  error_message: string | null
}

interface Summary {
  tldr: string | null
  executive_summary: string | null
  detailed_summary: string | null
  topics: string[]
  model_used: string | null
  cost_usd: number | null
}

interface ActionItem {
  id: string
  action: string
  owner_name: string | null
  owner_email: string | null
  due_date: string | null
  priority: ActionItemPriority
  status: string
  context_quote: string | null
}

interface Decision {
  id: string
  decision: string
  rationale: string | null
  decided_by: string | null
  stakeholders: string[]
  context_quote: string | null
}

interface TranscriptSeg {
  speaker: string | null
  text: string
  start_time: number | null
}

const PRIORITY_COLORS: Record<ActionItemPriority, string> = {
  P0: 'border-red-500/50 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400',
  P1: 'border-orange-500/50 bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-400',
  P2: 'border-blue-500/50 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400',
  P3: 'border-gray-500/50 bg-gray-50 text-gray-700 dark:bg-gray-950/30 dark:text-gray-400',
}

// ─── Component ──────────────────────────────────────────────────────

export default function MeetingDetailPage() {
  const params = useParams()
  const router = useRouter()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- meeting tables not in generated types yet (run `supabase gen types` after applying migration 022)
  const supabase = createClient() as any
  const meetingId = params.id as string

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [actionItems, setActionItems] = useState<ActionItem[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [transcript, setTranscript] = useState<TranscriptSeg[]>([])
  const [loading, setLoading] = useState(true)
  const [showTranscript, setShowTranscript] = useState(false)
  const [showDetailedSummary, setShowDetailedSummary] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [meetingRes, summaryRes, actionsRes, decisionsRes] = await Promise.all([
        supabase
          .from('meetings')
          .select('id, title, platform, scheduled_start, scheduled_end, actual_start, actual_end, duration_seconds, participants, status, summary_ready, transcript_ready, error_message')
          .eq('id', meetingId)
          .single(),
        supabase
          .from('meeting_summaries')
          .select('tldr, executive_summary, detailed_summary, topics, model_used, cost_usd')
          .eq('meeting_id', meetingId)
          .maybeSingle(),
        supabase
          .from('meeting_action_items')
          .select('id, action, owner_name, owner_email, due_date, priority, status, context_quote')
          .eq('meeting_id', meetingId)
          .order('priority', { ascending: true }),
        supabase
          .from('meeting_decisions')
          .select('id, decision, rationale, decided_by, stakeholders, context_quote')
          .eq('meeting_id', meetingId),
      ])

      if (meetingRes.error || !meetingRes.data) {
        toast.error('Meeting not found')
        router.push('/meetings')
        return
      }

      setMeeting(meetingRes.data as unknown as MeetingDetail)
      setSummary(summaryRes.data as unknown as Summary | null)
      setActionItems((actionsRes.data || []) as unknown as ActionItem[])
      setDecisions((decisionsRes.data || []) as unknown as Decision[])
    } catch (err) {
      console.error('Failed to load meeting:', err)
      toast.error('Failed to load meeting')
    } finally {
      setLoading(false)
    }
  }, [supabase, meetingId, router])

  useEffect(() => {
    loadData()
  }, [loadData])

  const loadTranscript = async () => {
    if (transcript.length > 0) {
      setShowTranscript(!showTranscript)
      return
    }

    const { data } = await supabase
      .from('transcript_segments')
      .select('speaker, text, start_time')
      .eq('meeting_id', meetingId)
      .eq('is_final', true)
      .order('start_time', { ascending: true })

    setTranscript((data || []) as unknown as TranscriptSeg[])
    setShowTranscript(true)
  }

  const toggleActionItem = async (itemId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'open' ? 'completed' : 'open'
    await supabase
      .from('meeting_action_items')
      .update({ status: newStatus })
      .eq('id', itemId)

    setActionItems(items =>
      items.map(i => i.id === itemId ? { ...i, status: newStatus } : i)
    )
    toast.success(newStatus === 'completed' ? 'Marked as done' : 'Reopened')
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="space-y-4">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-40 animate-pulse rounded-lg bg-muted" />
          <div className="h-60 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    )
  }

  if (!meeting) return null

  const date = meeting.scheduled_start ? new Date(meeting.scheduled_start) : null
  const duration = meeting.duration_seconds
    ? `${Math.round(meeting.duration_seconds / 60)} min`
    : null

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <Button variant="ghost" size="sm" onClick={() => router.push('/meetings')} className="mb-4 -ml-2">
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />
          Back to Meetings
        </Button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{meeting.title}</h1>
            <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
              {date && (
                <span className="flex items-center gap-1">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                  {' at '}
                  {date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              {duration && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  {duration}
                </span>
              )}
            </div>
          </div>

          <Badge
            variant="secondary"
            className={`shrink-0 ${
              meeting.status === 'completed'
                ? 'border-green-500/50 bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'
                : meeting.status === 'failed'
                  ? 'border-red-500/50 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
                  : 'border-blue-500/50 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400'
            }`}
          >
            {meeting.status === 'completed' && <CheckCircle2 className="h-3 w-3 mr-1" />}
            {meeting.status === 'failed' && <AlertCircle className="h-3 w-3 mr-1" />}
            {(meeting.status === 'processing' || meeting.status === 'transcribing') && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            {meeting.status.charAt(0).toUpperCase() + meeting.status.slice(1)}
          </Badge>
        </div>

        {/* Participants */}
        {meeting.participants.length > 0 && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            {meeting.participants.map((p, i) => (
              <Badge key={i} variant="secondary" className="text-[10px]">
                {p.name}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Error state */}
      {meeting.status === 'failed' && meeting.error_message && (
        <Card className="mb-6 border-destructive/50 shadow-sm">
          <CardContent className="py-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
              <div>
                <p className="text-sm font-medium text-destructive">Processing Failed</p>
                <p className="text-xs text-muted-foreground mt-1">{meeting.error_message}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Processing state */}
      {(meeting.status === 'processing' || meeting.status === 'transcribing') && (
        <Card className="mb-6 shadow-sm">
          <CardContent className="flex items-center gap-3 py-6 justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {meeting.status === 'transcribing' ? 'Transcribing audio...' : 'Generating summary...'}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-6">
        {/* ── TLDR ── */}
        {summary?.tldr && (
          <Card className="shadow-sm">
            <CardContent className="py-4">
              <p className="text-sm font-medium">{summary.tldr}</p>
            </CardContent>
          </Card>
        )}

        {/* ── Topics ── */}
        {summary?.topics && summary.topics.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {summary.topics.map((topic, i) => (
              <Badge key={i} variant="outline" className="text-xs">
                {topic}
              </Badge>
            ))}
          </div>
        )}

        {/* ── Executive Summary ── */}
        {summary?.executive_summary && (
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Lightbulb className="h-4 w-4" />
                Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed whitespace-pre-wrap">
                {summary.executive_summary}
              </div>
              {summary.detailed_summary && (
                <>
                  <button
                    onClick={() => setShowDetailedSummary(!showDetailedSummary)}
                    className="mt-3 flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    {showDetailedSummary ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    {showDetailedSummary ? 'Hide detailed summary' : 'Show detailed summary'}
                  </button>
                  {showDetailedSummary && (
                    <div className="mt-3 pt-3 border-t prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed whitespace-pre-wrap">
                      {summary.detailed_summary}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Action Items ── */}
        {actionItems.length > 0 && (
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <ListChecks className="h-4 w-4" />
                Action Items
                <Badge variant="secondary" className="text-[10px] ml-1">
                  {actionItems.filter(a => a.status === 'open').length} open
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {actionItems.map((item) => (
                  <div key={item.id} className="flex items-start gap-3">
                    <button
                      onClick={() => toggleActionItem(item.id, item.status)}
                      className={`mt-0.5 h-4 w-4 shrink-0 rounded border-2 transition-colors ${
                        item.status === 'completed'
                          ? 'border-green-500 bg-green-500'
                          : 'border-muted-foreground/30 hover:border-primary'
                      }`}
                    >
                      {item.status === 'completed' && (
                        <CheckCircle2 className="h-3 w-3 text-white" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${item.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>
                        {item.action}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {item.owner_name && (
                          <span className="text-xs text-muted-foreground">{item.owner_name}</span>
                        )}
                        {item.due_date && (
                          <span className="text-xs text-muted-foreground">Due: {item.due_date}</span>
                        )}
                        <Badge variant="secondary" className={`text-[9px] ${PRIORITY_COLORS[item.priority]}`}>
                          {item.priority}
                        </Badge>
                      </div>
                      {item.context_quote && (
                        <p className="mt-1 text-[11px] text-muted-foreground/70 italic">
                          &ldquo;{item.context_quote}&rdquo;
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Decisions ── */}
        {decisions.length > 0 && (
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Decisions
                <Badge variant="secondary" className="text-[10px] ml-1">
                  {decisions.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {decisions.map((d) => (
                  <div key={d.id} className="space-y-1">
                    <p className="text-sm font-medium">{d.decision}</p>
                    {d.rationale && (
                      <p className="text-xs text-muted-foreground">{d.rationale}</p>
                    )}
                    <div className="flex items-center gap-2">
                      {d.decided_by && (
                        <Badge variant="outline" className="text-[10px]">
                          {d.decided_by}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Transcript ── */}
        {meeting.transcript_ready && (
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <button
                onClick={loadTranscript}
                className="flex items-center justify-between w-full"
              >
                <CardTitle className="text-lg flex items-center gap-2">
                  <Mic className="h-4 w-4" />
                  Transcript
                </CardTitle>
                {showTranscript ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            </CardHeader>
            {showTranscript && (
              <CardContent>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {transcript.map((seg, i) => (
                    <div key={i} className="flex gap-3">
                      <div className="shrink-0 w-20 text-right">
                        <p className="text-xs font-medium text-primary">{seg.speaker || 'Unknown'}</p>
                        {seg.start_time != null && (
                          <p className="text-[10px] text-muted-foreground">
                            {Math.floor(seg.start_time / 60)}:{String(Math.floor(seg.start_time % 60)).padStart(2, '0')}
                          </p>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">{seg.text}</p>
                    </div>
                  ))}
                  {transcript.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">Loading transcript...</p>
                  )}
                </div>
              </CardContent>
            )}
          </Card>
        )}
      </div>
    </div>
  )
}
