'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  Mic, Clock, Users, CheckCircle2, AlertCircle, Loader2,
  Video, CalendarDays, ChevronRight, Search, Sparkles,
} from 'lucide-react'
import type { MeetingStatus, MeetingPlatform } from '@/types/meetings'

/* ─── Status visual config ─────────────────────────────────────────── */

interface StatusStyle {
  label: string
  dot: string
  text: string
  bg: string
  icon: React.ElementType
  pulse?: boolean
}

const STATUS_MAP: Record<MeetingStatus, StatusStyle> = {
  scheduled:    { label: 'Scheduled',    dot: 'bg-blue-500',    text: 'text-blue-700 dark:text-blue-300',    bg: 'bg-blue-50 dark:bg-blue-950/30',    icon: CalendarDays },
  joining:      { label: 'Joining',      dot: 'bg-amber-500',   text: 'text-amber-700 dark:text-amber-300',  bg: 'bg-amber-50 dark:bg-amber-950/30',  icon: Loader2, pulse: true },
  recording:    { label: 'Recording',    dot: 'bg-red-500',     text: 'text-red-700 dark:text-red-300',      bg: 'bg-red-50 dark:bg-red-950/30',      icon: Mic, pulse: true },
  transcribing: { label: 'Transcribing', dot: 'bg-violet-500',  text: 'text-violet-700 dark:text-violet-300', bg: 'bg-violet-50 dark:bg-violet-950/30', icon: Loader2, pulse: true },
  processing:   { label: 'Processing',   dot: 'bg-orange-500',  text: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-50 dark:bg-orange-950/30', icon: Loader2, pulse: true },
  completed:    { label: 'Completed',    dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-950/30', icon: CheckCircle2 },
  failed:       { label: 'Failed',       dot: 'bg-red-500',     text: 'text-red-700 dark:text-red-300',      bg: 'bg-red-50 dark:bg-red-950/30',      icon: AlertCircle },
  skipped:      { label: 'Skipped',      dot: 'bg-gray-400',    text: 'text-gray-600 dark:text-gray-400',    bg: 'bg-gray-50 dark:bg-gray-900/30',    icon: AlertCircle },
}

const PLATFORM_LABEL: Record<string, string> = {
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Teams',
}

/* ─── Types ────────────────────────────────────────────────────────── */

interface MeetingRow {
  id: string
  title: string
  platform: MeetingPlatform | null
  scheduled_start: string | null
  duration_seconds: number | null
  status: MeetingStatus
  participants: Array<{ name: string; email: string }>
  summary_ready: boolean
  created_at: string
}

type Filter = 'all' | 'upcoming' | 'completed'

/* ─── Helpers ──────────────────────────────────────────────────────── */

function relativeLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000)
  if (days < -1) return `${Math.abs(days)}d ago`
  if (days < 0)  return 'Today'
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days < 7)  return `In ${days}d`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function initials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

const AVATAR_RING = [
  'ring-blue-200 bg-blue-100 text-blue-700 dark:ring-blue-800 dark:bg-blue-900/60 dark:text-blue-300',
  'ring-emerald-200 bg-emerald-100 text-emerald-700 dark:ring-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300',
  'ring-violet-200 bg-violet-100 text-violet-700 dark:ring-violet-800 dark:bg-violet-900/60 dark:text-violet-300',
  'ring-amber-200 bg-amber-100 text-amber-700 dark:ring-amber-800 dark:bg-amber-900/60 dark:text-amber-300',
  'ring-rose-200 bg-rose-100 text-rose-700 dark:ring-rose-800 dark:bg-rose-900/60 dark:text-rose-300',
]

/* ─── Page ─────────────────────────────────────────────────────────── */

export default function MeetingsPage() {
  const supabase = createClient() as any
  const [meetings, setMeetings] = useState<MeetingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      let q = supabase
        .from('meetings')
        .select('id, title, platform, scheduled_start, duration_seconds, status, participants, summary_ready, created_at')
        .order('scheduled_start', { ascending: true })
        .limit(50)

      if (filter === 'upcoming')  q = q.in('status', ['scheduled', 'joining', 'recording'])
      if (filter === 'completed') q = q.eq('status', 'completed')

      const { data, error } = await q
      if (error) throw error
      setMeetings((data ?? []) as unknown as MeetingRow[])
    } catch (e) {
      console.error('Failed to load meetings:', e)
    } finally {
      setLoading(false)
    }
  }, [supabase, filter])

  useEffect(() => { load() }, [load])

  const visible = search
    ? meetings.filter(m => m.title.toLowerCase().includes(search.toLowerCase()))
    : meetings

  /* ─── Render ───────────────────────────────────────────────────── */

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="mb-8 sm:mb-10">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <Video className="h-5 w-5 text-primary" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
            <p className="text-[13px] text-muted-foreground leading-none mt-0.5">
              AI-powered summaries, action items &amp; transcripts
            </p>
          </div>
        </div>
      </header>

      {/* ── Toolbar ────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-col sm:flex-row gap-3">
        {/* Search */}
        <label className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search meetings…"
            className="w-full h-9 rounded-lg border border-border bg-card pl-9 pr-3 text-sm
                       placeholder:text-muted-foreground/40
                       focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40
                       transition-[box-shadow,border-color] duration-200"
          />
        </label>

        {/* Filter pills */}
        <nav className="flex gap-0.5 rounded-lg bg-muted/50 p-0.5" role="tablist">
          {(['all', 'upcoming', 'completed'] as const).map(f => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200
                ${filter === f
                  ? 'bg-card text-foreground shadow-sm ring-1 ring-border/60'
                  : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {f === 'all' ? 'All' : f === 'upcoming' ? 'Upcoming' : 'Completed'}
            </button>
          ))}
        </nav>
      </div>

      {/* ── List ───────────────────────────────────────────────────── */}
      {loading ? (
        <ul className="space-y-2.5" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <li key={i} className="h-[72px] rounded-xl bg-muted/30 animate-pulse" />
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50 mb-4">
            <Video className="h-6 w-6 text-muted-foreground/30" />
          </span>
          <p className="text-sm font-medium text-foreground/60 mb-0.5">No meetings found</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            {search ? 'Try a different search term.' : 'Your synced calendar meetings will appear here.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map(m => <MeetingCard key={m.id} m={m} />)}
        </ul>
      )}
    </div>
  )
}

/* ─── Meeting Card ─────────────────────────────────────────────────── */

function MeetingCard({ m }: { m: MeetingRow }) {
  const s = STATUS_MAP[m.status]
  const Icon = s.icon
  const isLive = m.status === 'recording'
  const date = m.scheduled_start ? new Date(m.scheduled_start) : null
  const dur = m.duration_seconds ? `${Math.round(m.duration_seconds / 60)}m` : null

  return (
    <li>
      <Link
        href={`/meetings/${m.id}`}
        className="group relative flex items-center gap-4 rounded-xl border border-border/50 bg-card
                   px-4 py-3.5 cursor-pointer
                   transition-all duration-200 ease-out
                   hover:border-border hover:shadow-[0_2px_12px_rgba(0,0,0,0.04)]
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        {/* Live accent */}
        {isLive && (
          <span className="absolute left-0 inset-y-3 w-[3px] rounded-full bg-red-500 animate-pulse" />
        )}

        {/* Icon */}
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 ${s.bg}`}>
          {m.summary_ready
            ? <Sparkles className="h-4 w-4 text-primary" />
            : <Icon className={`h-4 w-4 ${s.text} ${s.pulse ? 'animate-spin' : ''}`} />}
        </span>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-medium truncate group-hover:text-primary transition-colors duration-200">
              {m.title}
            </span>
            {m.platform && (
              <span className="hidden sm:inline-flex text-[10px] font-medium px-1.5 py-px rounded bg-muted text-muted-foreground">
                {PLATFORM_LABEL[m.platform] ?? m.platform}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {date && (
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3 w-3" />
                {date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                {', '}
                {date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
            {dur && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />{dur}
              </span>
            )}
            {m.participants.length > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1">
                <Users className="h-3 w-3" />{m.participants.length}
              </span>
            )}
          </div>
        </div>

        {/* Right */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Stacked avatars (desktop) */}
          {m.participants.length > 0 && (
            <div className="hidden md:flex -space-x-1.5">
              {m.participants.slice(0, 3).map((p, i) => (
                <span
                  key={i}
                  title={p.name}
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-semibold ring-2 ring-card ${AVATAR_RING[i % AVATAR_RING.length]}`}
                >
                  {initials(p.name)}
                </span>
              ))}
              {m.participants.length > 3 && (
                <span className="flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-medium ring-2 ring-card bg-muted text-muted-foreground">
                  +{m.participants.length - 3}
                </span>
              )}
            </div>
          )}

          {/* Relative tag */}
          {m.scheduled_start && (
            <span className="hidden lg:block text-[11px] text-muted-foreground/60 tabular-nums w-14 text-right">
              {relativeLabel(m.scheduled_start)}
            </span>
          )}

          {/* Status dot + label */}
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${s.bg} ${s.text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.pulse ? 'animate-pulse' : ''}`} />
            {s.label}
          </span>

          <ChevronRight className="h-4 w-4 text-muted-foreground/25 group-hover:text-primary/50 transition-colors duration-200" />
        </div>
      </Link>
    </li>
  )
}
