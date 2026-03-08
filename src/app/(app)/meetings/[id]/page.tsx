'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import {
  ArrowLeft, Mic, Clock, Users, CalendarDays,
  CheckCircle2, AlertCircle, Loader2, ChevronDown,
  ChevronUp, ListChecks, Lightbulb, MessageSquare,
  Sparkles, FileText, CircleCheck, Circle, Video,
  Hash, User2, Quote, Flag, ArrowUpRight,
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

type DetailTab = 'overview' | 'transcript' | 'actions' | 'decisions'

const PRIORITY_CONFIG: Record<ActionItemPriority, { label: string; color: string; bg: string }> = {
  P0: { label: 'Critical', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950/40' },
  P1: { label: 'High', color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950/40' },
  P2: { label: 'Medium', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/40' },
  P3: { label: 'Low', color: 'text-gray-500 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900/40' },
}

const SPEAKER_COLORS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300',
]

function getSpeakerColor(speaker: string, colorMap: Map<string, number>): string {
  if (!colorMap.has(speaker)) {
    colorMap.set(speaker, colorMap.size % SPEAKER_COLORS.length)
  }
  return SPEAKER_COLORS[colorMap.get(speaker)!]
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// ─── Component ──────────────────────────────────────────────────────

export default function MeetingDetailPage() {
  const params = useParams()
  const router = useRouter()
  const supabase = createClient() as any
  const meetingId = params.id as string

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [actionItems, setActionItems] = useState<ActionItem[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [transcript, setTranscript] = useState<TranscriptSeg[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const [transcriptLoaded, setTranscriptLoaded] = useState(false)
  const [showDetailedSummary, setShowDetailedSummary] = useState(false)
  const speakerColorMap = useRef(new Map<string, number>())

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

  // Load transcript lazily when tab is selected
  useEffect(() => {
    if (activeTab === 'transcript' && !transcriptLoaded) {
      (async () => {
        const { data } = await supabase
          .from('transcript_segments')
          .select('speaker, text, start_time')
          .eq('meeting_id', meetingId)
          .eq('is_final', true)
          .order('start_time', { ascending: true })

        setTranscript((data || []) as unknown as TranscriptSeg[])
        setTranscriptLoaded(true)
      })()
    }
  }, [activeTab, transcriptLoaded, supabase, meetingId])

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

  // ─── Loading / Not found ────────────────────────────────────────────

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
        <div className="space-y-4">
          <div className="h-5 w-32 animate-pulse rounded-md bg-muted/40" />
          <div className="h-8 w-64 animate-pulse rounded-md bg-muted/40" />
          <div className="h-4 w-48 animate-pulse rounded-md bg-muted/40" />
          <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 h-64 animate-pulse rounded-xl bg-muted/40" />
            <div className="h-64 animate-pulse rounded-xl bg-muted/40" />
          </div>
        </div>
      </div>
    )
  }

  if (!meeting) return null

  const date = meeting.scheduled_start ? new Date(meeting.scheduled_start) : null
  const duration = meeting.duration_seconds
    ? `${Math.round(meeting.duration_seconds / 60)} min`
    : null

  const openActions = actionItems.filter(a => a.status === 'open').length

  const tabs: { key: DetailTab; label: string; icon: React.ElementType; count?: number }[] = [
    { key: 'overview', label: 'Overview', icon: Sparkles },
    { key: 'transcript', label: 'Transcript', icon: FileText, count: transcript.length || undefined },
    { key: 'actions', label: 'Actions', icon: ListChecks, count: openActions || undefined },
    { key: 'decisions', label: 'Decisions', icon: MessageSquare, count: decisions.length || undefined },
  ]

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
      {/* Back nav */}
      <button
        onClick={() => router.push('/meetings')}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Meetings
      </button>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">{meeting.title}</h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
              {date && (
                <span className="flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                  {' at '}
                  {date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              {duration && (
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  {duration}
                </span>
              )}
            </div>
          </div>

          {/* Status pill */}
          <StatusPill status={meeting.status} />
        </div>

        {/* Participants */}
        {meeting.participants.length > 0 && (
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <div className="flex -space-x-1.5">
              {meeting.participants.slice(0, 6).map((p, i) => (
                <div
                  key={i}
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-background text-[10px] font-medium ${SPEAKER_COLORS[i % SPEAKER_COLORS.length]}`}
                  title={p.name}
                >
                  {getInitials(p.name)}
                </div>
              ))}
              {meeting.participants.length > 6 && (
                <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-medium text-muted-foreground">
                  +{meeting.participants.length - 6}
                </div>
              )}
            </div>
            <span className="text-xs text-muted-foreground ml-1">
              {meeting.participants.length} participant{meeting.participants.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>

      {/* Error state */}
      {meeting.status === 'failed' && meeting.error_message && (
        <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30">
          <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-700 dark:text-red-400">Processing Failed</p>
            <p className="text-xs text-red-600/70 dark:text-red-400/70 mt-0.5">{meeting.error_message}</p>
          </div>
        </div>
      )}

      {/* Processing state */}
      {(meeting.status === 'processing' || meeting.status === 'transcribing') && (
        <div className="mb-6 flex items-center gap-3 px-4 py-4 rounded-xl border border-border/60 bg-muted/30">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium">
              {meeting.status === 'transcribing' ? 'Transcribing audio...' : 'Generating summary...'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">This usually takes a few minutes.</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex gap-1 p-0.5 rounded-lg bg-muted/60 w-fit">
        {tabs.map((tab) => {
          const TabIcon = tab.icon
          // Hide transcript/actions/decisions tabs if no data and not completed
          if (tab.key === 'transcript' && !meeting.transcript_ready) return null
          if (tab.key === 'actions' && actionItems.length === 0) return null
          if (tab.key === 'decisions' && decisions.length === 0) return null

          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                activeTab === tab.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <TabIcon className="h-3.5 w-3.5" />
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span className={`ml-0.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                  activeTab === tab.key ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <OverviewTab
          summary={summary}
          showDetailedSummary={showDetailedSummary}
          setShowDetailedSummary={setShowDetailedSummary}
          actionItems={actionItems}
          decisions={decisions}
          toggleActionItem={toggleActionItem}
          meeting={meeting}
        />
      )}

      {activeTab === 'transcript' && (
        <TranscriptTab
          transcript={transcript}
          transcriptLoaded={transcriptLoaded}
          speakerColorMap={speakerColorMap.current}
        />
      )}

      {activeTab === 'actions' && (
        <ActionsTab
          actionItems={actionItems}
          toggleActionItem={toggleActionItem}
        />
      )}

      {activeTab === 'decisions' && (
        <DecisionsTab decisions={decisions} />
      )}
    </div>
  )
}

// ─── Status Pill ──────────────────────────────────────────────────────

function StatusPill({ status }: { status: MeetingStatus }) {
  const configs: Record<MeetingStatus, { label: string; color: string; bg: string; icon: React.ElementType; spin?: boolean }> = {
    scheduled: { label: 'Scheduled', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/40', icon: CalendarDays },
    joining: { label: 'Joining', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/40', icon: Loader2, spin: true },
    recording: { label: 'Recording', color: 'text-red-500 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950/40', icon: Mic },
    transcribing: { label: 'Transcribing', color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-950/40', icon: Loader2, spin: true },
    processing: { label: 'Processing', color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950/40', icon: Loader2, spin: true },
    completed: { label: 'Completed', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/40', icon: CheckCircle2 },
    failed: { label: 'Failed', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950/40', icon: AlertCircle },
    skipped: { label: 'Skipped', color: 'text-gray-500 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-950/40', icon: AlertCircle },
  }

  const cfg = configs[status]
  const Icon = cfg.icon

  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ${cfg.bg} ${cfg.color}`}>
      <Icon className={`h-3.5 w-3.5 ${cfg.spin ? 'animate-spin' : ''}`} />
      {cfg.label}
    </div>
  )
}

// ─── Overview Tab ─────────────────────────────────────────────────────

function OverviewTab({
  summary,
  showDetailedSummary,
  setShowDetailedSummary,
  actionItems,
  decisions,
  toggleActionItem,
  meeting,
}: {
  summary: Summary | null
  showDetailedSummary: boolean
  setShowDetailedSummary: (v: boolean) => void
  actionItems: ActionItem[]
  decisions: Decision[]
  toggleActionItem: (id: string, status: string) => void
  meeting: MeetingDetail
}) {
  // Show a waiting state if the meeting hasn't been processed yet
  if (!summary && meeting.status !== 'completed' && meeting.status !== 'failed') {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/60 mb-4">
          <Video className="h-6 w-6 text-muted-foreground/40" />
        </div>
        <p className="text-sm font-medium text-foreground/70">Waiting for meeting to complete</p>
        <p className="text-xs text-muted-foreground mt-1">
          Summary, action items, and decisions will appear here after the meeting is recorded and processed.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* Main content (3/5) */}
      <div className="lg:col-span-3 space-y-5">
        {/* TLDR */}
        {summary?.tldr && (
          <div className="px-4 py-3 rounded-xl bg-primary/5 border border-primary/10">
            <div className="flex items-start gap-2">
              <Sparkles className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <p className="text-sm font-medium leading-relaxed">{summary.tldr}</p>
            </div>
          </div>
        )}

        {/* Topics */}
        {summary?.topics && summary.topics.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Hash className="h-3.5 w-3.5 text-muted-foreground" />
            {summary.topics.map((topic, i) => (
              <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-muted/80 text-muted-foreground">
                {topic}
              </span>
            ))}
          </div>
        )}

        {/* Executive Summary */}
        {summary?.executive_summary && (
          <div className="rounded-xl border border-border/60 bg-card">
            <div className="px-5 py-3.5 border-b border-border/60">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-amber-500" />
                Summary
              </h3>
            </div>
            <div className="px-5 py-4">
              <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/85">
                {summary.executive_summary}
              </div>
              {summary.detailed_summary && (
                <>
                  <button
                    onClick={() => setShowDetailedSummary(!showDetailedSummary)}
                    className="mt-4 flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                  >
                    {showDetailedSummary ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    {showDetailedSummary ? 'Hide detailed summary' : 'Show detailed summary'}
                  </button>
                  {showDetailedSummary && (
                    <div className="mt-3 pt-3 border-t border-border/60 prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/85">
                      {summary.detailed_summary}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sidebar (2/5) */}
      <div className="lg:col-span-2 space-y-5">
        {/* Action items preview */}
        {actionItems.length > 0 && (
          <div className="rounded-xl border border-border/60 bg-card">
            <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ListChecks className="h-4 w-4 text-primary" />
                Action Items
              </h3>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                {actionItems.filter(a => a.status === 'open').length} open
              </span>
            </div>
            <div className="px-4 py-3 space-y-2.5">
              {actionItems.slice(0, 4).map((item) => (
                <div key={item.id} className="flex items-start gap-2.5">
                  <button
                    onClick={() => toggleActionItem(item.id, item.status)}
                    className="mt-0.5 shrink-0"
                  >
                    {item.status === 'completed' ? (
                      <CircleCheck className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground/40 hover:text-primary transition-colors" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs leading-relaxed ${item.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground/90'}`}>
                      {item.action}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {item.owner_name && (
                        <span className="text-[10px] text-muted-foreground">{item.owner_name}</span>
                      )}
                      <span className={`text-[9px] font-medium px-1 py-0.5 rounded ${PRIORITY_CONFIG[item.priority].bg} ${PRIORITY_CONFIG[item.priority].color}`}>
                        {item.priority}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
              {actionItems.length > 4 && (
                <p className="text-[11px] text-muted-foreground pt-1">
                  +{actionItems.length - 4} more
                </p>
              )}
            </div>
          </div>
        )}

        {/* Decisions preview */}
        {decisions.length > 0 && (
          <div className="rounded-xl border border-border/60 bg-card">
            <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-violet-500" />
                Decisions
              </h3>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400">
                {decisions.length}
              </span>
            </div>
            <div className="px-4 py-3 space-y-3">
              {decisions.slice(0, 3).map((d) => (
                <div key={d.id}>
                  <p className="text-xs font-medium text-foreground/90">{d.decision}</p>
                  {d.decided_by && (
                    <span className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                      <User2 className="h-2.5 w-2.5" />
                      {d.decided_by}
                    </span>
                  )}
                </div>
              ))}
              {decisions.length > 3 && (
                <p className="text-[11px] text-muted-foreground">
                  +{decisions.length - 3} more
                </p>
              )}
            </div>
          </div>
        )}

        {/* Meeting info */}
        <div className="rounded-xl border border-border/60 bg-card px-4 py-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Details</h3>
          <div className="space-y-2.5 text-xs">
            {meeting.platform && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Platform</span>
                <span className="font-medium capitalize">{meeting.platform.replace('_', ' ')}</span>
              </div>
            )}
            {meeting.participants.length > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Participants</span>
                <span className="font-medium">{meeting.participants.length}</span>
              </div>
            )}
            {meeting.duration_seconds && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Duration</span>
                <span className="font-medium">{Math.round(meeting.duration_seconds / 60)} min</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Transcript</span>
              <span className="font-medium">{meeting.transcript_ready ? 'Ready' : 'Pending'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Summary</span>
              <span className="font-medium">{meeting.summary_ready ? 'Ready' : 'Pending'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Transcript Tab ───────────────────────────────────────────────────

function TranscriptTab({
  transcript,
  transcriptLoaded,
  speakerColorMap,
}: {
  transcript: TranscriptSeg[]
  transcriptLoaded: boolean
  speakerColorMap: Map<string, number>
}) {
  if (!transcriptLoaded) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading transcript...</span>
      </div>
    )
  }

  if (transcript.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <FileText className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-sm text-muted-foreground">No transcript segments found.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border/60 flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          Full Transcript
        </h3>
        <span className="text-[11px] text-muted-foreground">{transcript.length} segments</span>
      </div>
      <div className="divide-y divide-border/40 max-h-[600px] overflow-y-auto">
        {transcript.map((seg, i) => {
          const speaker = seg.speaker || 'Unknown'
          const colorClass = getSpeakerColor(speaker, speakerColorMap)

          return (
            <div key={i} className="flex gap-3 px-5 py-3 hover:bg-accent/20 transition-colors">
              {/* Speaker avatar */}
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${colorClass}`}>
                {getInitials(speaker)}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-semibold">{speaker}</span>
                  {seg.start_time != null && (
                    <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                      {formatTimestamp(seg.start_time)}
                    </span>
                  )}
                </div>
                <p className="text-[13px] leading-relaxed text-foreground/80">{seg.text}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Actions Tab ──────────────────────────────────────────────────────

function ActionsTab({
  actionItems,
  toggleActionItem,
}: {
  actionItems: ActionItem[]
  toggleActionItem: (id: string, status: string) => void
}) {
  const openItems = actionItems.filter(a => a.status === 'open')
  const completedItems = actionItems.filter(a => a.status === 'completed')

  return (
    <div className="space-y-6">
      {/* Open items */}
      {openItems.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border/60">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-primary" />
              Open
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                {openItems.length}
              </span>
            </h3>
          </div>
          <div className="divide-y divide-border/40">
            {openItems.map((item) => (
              <ActionItemRow key={item.id} item={item} onToggle={toggleActionItem} />
            ))}
          </div>
        </div>
      )}

      {/* Completed items */}
      {completedItems.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border/60">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Completed
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                {completedItems.length}
              </span>
            </h3>
          </div>
          <div className="divide-y divide-border/40">
            {completedItems.map((item) => (
              <ActionItemRow key={item.id} item={item} onToggle={toggleActionItem} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ActionItemRow({
  item,
  onToggle,
}: {
  item: ActionItem
  onToggle: (id: string, status: string) => void
}) {
  const priorityConfig = PRIORITY_CONFIG[item.priority]
  const isCompleted = item.status === 'completed'

  return (
    <div className="flex items-start gap-3 px-5 py-3.5">
      <button
        onClick={() => onToggle(item.id, item.status)}
        className="mt-0.5 shrink-0"
      >
        {isCompleted ? (
          <CircleCheck className="h-[18px] w-[18px] text-emerald-500" />
        ) : (
          <Circle className="h-[18px] w-[18px] text-muted-foreground/40 hover:text-primary transition-colors" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-relaxed ${isCompleted ? 'line-through text-muted-foreground' : ''}`}>
          {item.action}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {item.owner_name && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <User2 className="h-3 w-3" />
              {item.owner_name}
            </span>
          )}
          {item.due_date && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <CalendarDays className="h-3 w-3" />
              {item.due_date}
            </span>
          )}
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${priorityConfig.bg} ${priorityConfig.color}`}>
            {item.priority} — {priorityConfig.label}
          </span>
        </div>
        {item.context_quote && (
          <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground/70 italic">
            <Quote className="h-3 w-3 shrink-0 mt-0.5" />
            <span>&ldquo;{item.context_quote}&rdquo;</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Decisions Tab ────────────────────────────────────────────────────

function DecisionsTab({ decisions }: { decisions: Decision[] }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border/60">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-violet-500" />
          Decisions
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400">
            {decisions.length}
          </span>
        </h3>
      </div>
      <div className="divide-y divide-border/40">
        {decisions.map((d) => (
          <div key={d.id} className="px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/40">
                <Flag className="h-3.5 w-3.5 text-violet-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{d.decision}</p>
                {d.rationale && (
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{d.rationale}</p>
                )}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {d.decided_by && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <User2 className="h-3 w-3" />
                      {d.decided_by}
                    </span>
                  )}
                  {d.stakeholders.length > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {d.stakeholders.join(', ')}
                    </span>
                  )}
                </div>
                {d.context_quote && (
                  <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground/70 italic">
                    <Quote className="h-3 w-3 shrink-0 mt-0.5" />
                    <span>&ldquo;{d.context_quote}&rdquo;</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
