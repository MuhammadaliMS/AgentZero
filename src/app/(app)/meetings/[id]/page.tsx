'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import {
  ArrowLeft, Mic, Clock, Users, CalendarDays,
  CheckCircle2, AlertCircle, Loader2, ChevronDown,
  ChevronUp, ListChecks, Lightbulb, MessageSquare,
  Sparkles, FileText, CircleCheck, Circle, Video,
  Hash, User2, Quote, Flag,
} from 'lucide-react'
import type { MeetingStatus, ActionItemPriority } from '@/types/meetings'

/* ═══════════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════════ */

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

interface Segment {
  speaker: string | null
  text: string
  start_time: number | null
}

type Tab = 'overview' | 'transcript' | 'actions' | 'decisions'

/* ═══════════════════════════════════════════════════════════════════════
   Design tokens
   ═══════════════════════════════════════════════════════════════════════ */

const PRIORITY: Record<ActionItemPriority, { label: string; cls: string }> = {
  P0: { label: 'Critical', cls: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40' },
  P1: { label: 'High',     cls: 'text-orange-700 bg-orange-50 dark:text-orange-300 dark:bg-orange-950/40' },
  P2: { label: 'Medium',   cls: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40' },
  P3: { label: 'Low',      cls: 'text-gray-600 bg-gray-50 dark:text-gray-400 dark:bg-gray-900/40' },
}

const SPEAKER_CLS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300',
]

/* ═══════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════ */

function ini(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}
function ts(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}
function speakerCls(s: string, map: Map<string, number>) {
  if (!map.has(s)) map.set(s, map.size % SPEAKER_CLS.length)
  return SPEAKER_CLS[map.get(s)!]
}

/* ═══════════════════════════════════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════════════════════════════════ */

export default function MeetingDetailPage() {
  const params  = useParams()
  const router  = useRouter()
  const sb      = createClient() as any
  const id      = params.id as string

  const [meeting,   setMeeting]   = useState<MeetingDetail | null>(null)
  const [summary,   setSummary]   = useState<Summary | null>(null)
  const [actions,   setActions]   = useState<ActionItem[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [segs,      setSegs]      = useState<Segment[]>([])
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState<Tab>('overview')
  const [segsLoaded, setSegsLoaded] = useState(false)
  const [detailedOpen, setDetailedOpen] = useState(false)
  const colorMap = useRef(new Map<string, number>())

  /* ── Fetch core data ─────────────────────────────────────────────── */

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [mR, sR, aR, dR] = await Promise.all([
        sb.from('meetings').select('id, title, platform, scheduled_start, scheduled_end, actual_start, actual_end, duration_seconds, participants, status, summary_ready, transcript_ready, error_message').eq('id', id).single(),
        sb.from('meeting_summaries').select('tldr, executive_summary, detailed_summary, topics, model_used, cost_usd').eq('meeting_id', id).maybeSingle(),
        sb.from('meeting_action_items').select('id, action, owner_name, owner_email, due_date, priority, status, context_quote').eq('meeting_id', id).order('priority', { ascending: true }),
        sb.from('meeting_decisions').select('id, decision, rationale, decided_by, stakeholders, context_quote').eq('meeting_id', id),
      ])
      if (mR.error || !mR.data) { toast.error('Meeting not found'); router.push('/meetings'); return }
      setMeeting(mR.data as unknown as MeetingDetail)
      setSummary(sR.data as unknown as Summary | null)
      setActions((aR.data ?? []) as unknown as ActionItem[])
      setDecisions((dR.data ?? []) as unknown as Decision[])
    } catch { toast.error('Failed to load meeting') }
    finally { setLoading(false) }
  }, [sb, id, router])

  useEffect(() => { load() }, [load])

  /* ── Lazy-load transcript ────────────────────────────────────────── */

  useEffect(() => {
    if (tab !== 'transcript' || segsLoaded) return
    ;(async () => {
      const { data } = await sb.from('transcript_segments').select('speaker, text, start_time').eq('meeting_id', id).eq('is_final', true).order('start_time', { ascending: true })
      setSegs((data ?? []) as unknown as Segment[])
      setSegsLoaded(true)
    })()
  }, [tab, segsLoaded, sb, id])

  /* ── Toggle action item ──────────────────────────────────────────── */

  const toggle = async (itemId: string, cur: string) => {
    const next = cur === 'open' ? 'completed' : 'open'
    await sb.from('meeting_action_items').update({ status: next }).eq('id', itemId)
    setActions(prev => prev.map(a => a.id === itemId ? { ...a, status: next } : a))
    toast.success(next === 'completed' ? 'Marked as done' : 'Reopened')
  }

  /* ── Loading skeleton ────────────────────────────────────────────── */

  if (loading) return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-4">
      <div className="h-4 w-28 rounded bg-muted/30 animate-pulse" />
      <div className="h-7 w-72 rounded bg-muted/30 animate-pulse" />
      <div className="h-4 w-52 rounded bg-muted/30 animate-pulse" />
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 h-64 rounded-xl bg-muted/30 animate-pulse" />
        <div className="h-64 rounded-xl bg-muted/30 animate-pulse" />
      </div>
    </div>
  )

  if (!meeting) return null

  const date = meeting.scheduled_start ? new Date(meeting.scheduled_start) : null
  const dur  = meeting.duration_seconds ? `${Math.round(meeting.duration_seconds / 60)} min` : null
  const open = actions.filter(a => a.status === 'open').length

  const tabDef: { key: Tab; label: string; icon: React.ElementType; badge?: number; show: boolean }[] = [
    { key: 'overview',   label: 'Overview',   icon: Sparkles,       show: true },
    { key: 'transcript', label: 'Transcript', icon: FileText,       badge: segs.length || undefined, show: meeting.transcript_ready },
    { key: 'actions',    label: 'Actions',    icon: ListChecks,     badge: open || undefined,        show: actions.length > 0 },
    { key: 'decisions',  label: 'Decisions',  icon: MessageSquare,  badge: decisions.length || undefined, show: decisions.length > 0 },
  ]

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">

      {/* ── Back ────────────────────────────────────────────────────── */}
      <button
        onClick={() => router.push('/meetings')}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground
                   transition-colors duration-200 mb-6 cursor-pointer
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Meetings
      </button>

      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">{meeting.title}</h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
              {date && (
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                  {' at '}
                  {date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              {dur && (
                <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />{dur}</span>
              )}
            </div>
          </div>
          <StatusChip status={meeting.status} />
        </div>

        {/* Participant avatars */}
        {meeting.participants.length > 0 && (
          <div className="mt-4 flex items-center gap-2.5 flex-wrap">
            <div className="flex -space-x-1.5">
              {meeting.participants.slice(0, 6).map((p, i) => (
                <span
                  key={i}
                  title={p.name}
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold ring-2 ring-card ${SPEAKER_CLS[i % SPEAKER_CLS.length]}`}
                >
                  {ini(p.name)}
                </span>
              ))}
              {meeting.participants.length > 6 && (
                <span className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-medium ring-2 ring-card bg-muted text-muted-foreground">
                  +{meeting.participants.length - 6}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {meeting.participants.length} participant{meeting.participants.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </header>

      {/* ── Alerts ──────────────────────────────────────────────────── */}
      {meeting.status === 'failed' && meeting.error_message && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/20">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-700 dark:text-red-300">Processing Failed</p>
            <p className="text-xs text-red-600/80 dark:text-red-400/70 mt-0.5">{meeting.error_message}</p>
          </div>
        </div>
      )}

      {(meeting.status === 'processing' || meeting.status === 'transcribing') && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-4">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium">{meeting.status === 'transcribing' ? 'Transcribing audio…' : 'Generating summary…'}</p>
            <p className="text-xs text-muted-foreground mt-0.5">This usually takes a few minutes.</p>
          </div>
        </div>
      )}

      {/* ── Tab bar ─────────────────────────────────────────────────── */}
      <nav className="mb-6 flex gap-0.5 rounded-lg bg-muted/50 p-0.5 w-fit" role="tablist">
        {tabDef.filter(t => t.show).map(t => {
          const I = t.icon
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium cursor-pointer
                transition-all duration-200
                ${tab === t.key
                  ? 'bg-card text-foreground shadow-sm ring-1 ring-border/60'
                  : 'text-muted-foreground hover:text-foreground'
                }
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30`}
            >
              <I className="h-3.5 w-3.5" />
              {t.label}
              {t.badge != null && t.badge > 0 && (
                <span className={`text-[10px] px-1.5 py-px rounded-full ${tab === t.key ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  {t.badge}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* ── Tab content ─────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <OverviewPane
          meeting={meeting} summary={summary} actions={actions}
          decisions={decisions} toggle={toggle}
          detailedOpen={detailedOpen} setDetailedOpen={setDetailedOpen}
        />
      )}
      {tab === 'transcript' && <TranscriptPane segs={segs} loaded={segsLoaded} colorMap={colorMap.current} />}
      {tab === 'actions' && <ActionsPane items={actions} toggle={toggle} />}
      {tab === 'decisions' && <DecisionsPane items={decisions} />}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Status Chip ───────────────────────────────────────────────────── */

function StatusChip({ status }: { status: MeetingStatus }) {
  const map: Record<MeetingStatus, { l: string; c: string; bg: string; icon: React.ElementType; spin?: boolean }> = {
    scheduled:    { l: 'Scheduled',    c: 'text-blue-700 dark:text-blue-300',    bg: 'bg-blue-50 dark:bg-blue-950/30',    icon: CalendarDays },
    joining:      { l: 'Joining',      c: 'text-amber-700 dark:text-amber-300',  bg: 'bg-amber-50 dark:bg-amber-950/30',  icon: Loader2, spin: true },
    recording:    { l: 'Recording',    c: 'text-red-700 dark:text-red-300',      bg: 'bg-red-50 dark:bg-red-950/30',      icon: Mic },
    transcribing: { l: 'Transcribing', c: 'text-violet-700 dark:text-violet-300', bg: 'bg-violet-50 dark:bg-violet-950/30', icon: Loader2, spin: true },
    processing:   { l: 'Processing',   c: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-50 dark:bg-orange-950/30', icon: Loader2, spin: true },
    completed:    { l: 'Completed',    c: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-950/30', icon: CheckCircle2 },
    failed:       { l: 'Failed',       c: 'text-red-700 dark:text-red-300',      bg: 'bg-red-50 dark:bg-red-950/30',      icon: AlertCircle },
    skipped:      { l: 'Skipped',      c: 'text-gray-600 dark:text-gray-400',    bg: 'bg-gray-50 dark:bg-gray-900/30',    icon: AlertCircle },
  }
  const s = map[status]; const I = s.icon
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${s.bg} ${s.c}`}>
      <I className={`h-3.5 w-3.5 ${s.spin ? 'animate-spin' : ''}`} />{s.l}
    </span>
  )
}

/* ── Section shell ─────────────────────────────────────────────────── */

function Section({ title, icon: I, badge, children, accent = 'text-primary' }: {
  title: string; icon: React.ElementType; badge?: React.ReactNode; children: React.ReactNode; accent?: string
}) {
  return (
    <section className="rounded-xl border border-border/50 bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/50">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <I className={`h-4 w-4 ${accent}`} />{title}
        </h3>
        {badge}
      </div>
      {children}
    </section>
  )
}

/* ── Overview Pane ─────────────────────────────────────────────────── */

function OverviewPane({ meeting, summary, actions, decisions, toggle, detailedOpen, setDetailedOpen }: {
  meeting: MeetingDetail; summary: Summary | null; actions: ActionItem[]; decisions: Decision[]
  toggle: (id: string, s: string) => void
  detailedOpen: boolean; setDetailedOpen: (v: boolean) => void
}) {
  if (!summary && meeting.status !== 'completed' && meeting.status !== 'failed') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50 mb-4">
          <Video className="h-6 w-6 text-muted-foreground/30" />
        </span>
        <p className="text-sm font-medium text-foreground/60">Waiting for meeting</p>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-xs">
          Summary, actions and decisions appear after recording &amp; processing.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
      {/* ── Main column (3/5) ──────────────────────────────────────── */}
      <div className="lg:col-span-3 space-y-5">

        {/* TLDR */}
        {summary?.tldr && (
          <div className="rounded-xl bg-primary/[0.04] border border-primary/10 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <Sparkles className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <p className="text-sm font-medium leading-relaxed">{summary.tldr}</p>
            </div>
          </div>
        )}

        {/* Topics */}
        {summary?.topics && summary.topics.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Hash className="h-3.5 w-3.5 text-muted-foreground/60" />
            {summary.topics.map((t, i) => (
              <span key={i} className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-muted/70 text-muted-foreground">{t}</span>
            ))}
          </div>
        )}

        {/* Executive Summary */}
        {summary?.executive_summary && (
          <Section title="Summary" icon={Lightbulb} accent="text-amber-500">
            <div className="px-5 py-4">
              <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/85">
                {summary.executive_summary}
              </div>
              {summary.detailed_summary && (
                <>
                  <button
                    onClick={() => setDetailedOpen(!detailedOpen)}
                    className="mt-4 flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors duration-200"
                  >
                    {detailedOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    {detailedOpen ? 'Hide detailed summary' : 'Show detailed summary'}
                  </button>
                  {detailedOpen && (
                    <div className="mt-3 pt-3 border-t border-border/50 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/85">
                      {summary.detailed_summary}
                    </div>
                  )}
                </>
              )}
            </div>
          </Section>
        )}
      </div>

      {/* ── Sidebar (2/5) ──────────────────────────────────────────── */}
      <aside className="lg:col-span-2 space-y-5">

        {/* Action items mini */}
        {actions.length > 0 && (
          <Section
            title="Action Items" icon={ListChecks}
            badge={<span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">{actions.filter(a => a.status === 'open').length} open</span>}
          >
            <div className="px-4 py-3 space-y-2.5">
              {actions.slice(0, 4).map(a => (
                <div key={a.id} className="flex items-start gap-2.5">
                  <button onClick={() => toggle(a.id, a.status)} className="mt-0.5 shrink-0 cursor-pointer">
                    {a.status === 'completed'
                      ? <CircleCheck className="h-4 w-4 text-emerald-500" />
                      : <Circle className="h-4 w-4 text-muted-foreground/35 hover:text-primary transition-colors duration-200" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs leading-relaxed ${a.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground/90'}`}>{a.action}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {a.owner_name && <span className="text-[10px] text-muted-foreground">{a.owner_name}</span>}
                      <span className={`text-[9px] font-medium px-1 py-0.5 rounded ${PRIORITY[a.priority].cls}`}>{a.priority}</span>
                    </div>
                  </div>
                </div>
              ))}
              {actions.length > 4 && <p className="text-[11px] text-muted-foreground pt-0.5">+{actions.length - 4} more</p>}
            </div>
          </Section>
        )}

        {/* Decisions mini */}
        {decisions.length > 0 && (
          <Section
            title="Decisions" icon={MessageSquare} accent="text-violet-500"
            badge={<span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400">{decisions.length}</span>}
          >
            <div className="px-4 py-3 space-y-3">
              {decisions.slice(0, 3).map(d => (
                <div key={d.id}>
                  <p className="text-xs font-medium text-foreground/90">{d.decision}</p>
                  {d.decided_by && <span className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5"><User2 className="h-2.5 w-2.5" />{d.decided_by}</span>}
                </div>
              ))}
              {decisions.length > 3 && <p className="text-[11px] text-muted-foreground">+{decisions.length - 3} more</p>}
            </div>
          </Section>
        )}

        {/* Meta card */}
        <div className="rounded-xl border border-border/50 bg-card px-4 py-3.5">
          <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">Details</h3>
          <dl className="space-y-2 text-xs">
            {meeting.platform && <Row label="Platform" value={meeting.platform.replace('_', ' ')} />}
            {meeting.participants.length > 0 && <Row label="Participants" value={String(meeting.participants.length)} />}
            {meeting.duration_seconds && <Row label="Duration" value={`${Math.round(meeting.duration_seconds / 60)} min`} />}
            <Row label="Transcript" value={meeting.transcript_ready ? 'Ready' : 'Pending'} />
            <Row label="Summary" value={meeting.summary_ready ? 'Ready' : 'Pending'} />
          </dl>
        </div>
      </aside>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium capitalize">{value}</dd>
    </div>
  )
}

/* ── Transcript Pane ───────────────────────────────────────────────── */

function TranscriptPane({ segs, loaded, colorMap }: { segs: Segment[]; loaded: boolean; colorMap: Map<string, number> }) {
  if (!loaded) return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      <span className="ml-2 text-sm text-muted-foreground">Loading transcript…</span>
    </div>
  )
  if (segs.length === 0) return (
    <div className="flex flex-col items-center justify-center py-16">
      <FileText className="h-8 w-8 text-muted-foreground/25 mb-2" />
      <p className="text-sm text-muted-foreground">No transcript segments.</p>
    </div>
  )

  return (
    <Section title="Full Transcript" icon={FileText} badge={<span className="text-[11px] text-muted-foreground">{segs.length} segments</span>}>
      <div className="divide-y divide-border/30 max-h-[640px] overflow-y-auto">
        {segs.map((s, i) => {
          const name = s.speaker || 'Unknown'
          return (
            <div key={i} className="flex gap-3 px-5 py-3 hover:bg-accent/20 transition-colors duration-150">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${speakerCls(name, colorMap)}`}>
                {ini(name)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-semibold">{name}</span>
                  {s.start_time != null && <span className="text-[10px] text-muted-foreground/50 tabular-nums">{ts(s.start_time)}</span>}
                </div>
                <p className="text-[13px] leading-relaxed text-foreground/80">{s.text}</p>
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

/* ── Actions Pane ──────────────────────────────────────────────────── */

function ActionsPane({ items, toggle }: { items: ActionItem[]; toggle: (id: string, s: string) => void }) {
  const open = items.filter(a => a.status === 'open')
  const done = items.filter(a => a.status === 'completed')

  return (
    <div className="space-y-5">
      {open.length > 0 && (
        <Section title="Open" icon={ListChecks} badge={<span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">{open.length}</span>}>
          <div className="divide-y divide-border/30">{open.map(a => <ActionRow key={a.id} a={a} toggle={toggle} />)}</div>
        </Section>
      )}
      {done.length > 0 && (
        <Section title="Completed" icon={CheckCircle2} accent="text-emerald-500" badge={<span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">{done.length}</span>}>
          <div className="divide-y divide-border/30">{done.map(a => <ActionRow key={a.id} a={a} toggle={toggle} />)}</div>
        </Section>
      )}
    </div>
  )
}

function ActionRow({ a, toggle }: { a: ActionItem; toggle: (id: string, s: string) => void }) {
  const isDone = a.status === 'completed'
  return (
    <div className="flex items-start gap-3 px-5 py-3.5">
      <button onClick={() => toggle(a.id, a.status)} className="mt-0.5 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-full">
        {isDone ? <CircleCheck className="h-[18px] w-[18px] text-emerald-500" /> : <Circle className="h-[18px] w-[18px] text-muted-foreground/35 hover:text-primary transition-colors duration-200" />}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-relaxed ${isDone ? 'line-through text-muted-foreground' : ''}`}>{a.action}</p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {a.owner_name && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><User2 className="h-3 w-3" />{a.owner_name}</span>}
          {a.due_date && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><CalendarDays className="h-3 w-3" />{a.due_date}</span>}
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${PRIORITY[a.priority].cls}`}>{a.priority} — {PRIORITY[a.priority].label}</span>
        </div>
        {a.context_quote && (
          <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground/60 italic">
            <Quote className="h-3 w-3 shrink-0 mt-0.5" /><span>&ldquo;{a.context_quote}&rdquo;</span>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Decisions Pane ────────────────────────────────────────────────── */

function DecisionsPane({ items }: { items: Decision[] }) {
  return (
    <Section title="Decisions" icon={MessageSquare} accent="text-violet-500" badge={<span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400">{items.length}</span>}>
      <div className="divide-y divide-border/30">
        {items.map(d => (
          <div key={d.id} className="px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/40">
                <Flag className="h-3.5 w-3.5 text-violet-500" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{d.decision}</p>
                {d.rationale && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{d.rationale}</p>}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {d.decided_by && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><User2 className="h-3 w-3" />{d.decided_by}</span>}
                  {d.stakeholders.length > 0 && <span className="text-[11px] text-muted-foreground">{d.stakeholders.join(', ')}</span>}
                </div>
                {d.context_quote && (
                  <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground/60 italic">
                    <Quote className="h-3 w-3 shrink-0 mt-0.5" /><span>&ldquo;{d.context_quote}&rdquo;</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}
