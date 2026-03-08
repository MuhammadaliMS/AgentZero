'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import {
  Mic, Clock, Users, CheckCircle2, AlertCircle, Loader2,
  Video, CalendarDays, ArrowRight, Search, Sparkles,
} from 'lucide-react'
import type { MeetingStatus, MeetingPlatform } from '@/types/meetings'

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

const STATUS_CONFIG: Record<MeetingStatus, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  scheduled: { label: 'Scheduled', color: 'text-blue-600 dark:text-blue-400', bgColor: 'bg-blue-50 dark:bg-blue-950/40', icon: CalendarDays },
  joining: { label: 'Joining...', color: 'text-amber-600 dark:text-amber-400', bgColor: 'bg-amber-50 dark:bg-amber-950/40', icon: Loader2 },
  recording: { label: 'Recording', color: 'text-red-500 dark:text-red-400', bgColor: 'bg-red-50 dark:bg-red-950/40', icon: Mic },
  transcribing: { label: 'Transcribing', color: 'text-violet-600 dark:text-violet-400', bgColor: 'bg-violet-50 dark:bg-violet-950/40', icon: Loader2 },
  processing: { label: 'Processing', color: 'text-orange-600 dark:text-orange-400', bgColor: 'bg-orange-50 dark:bg-orange-950/40', icon: Loader2 },
  completed: { label: 'Completed', color: 'text-emerald-600 dark:text-emerald-400', bgColor: 'bg-emerald-50 dark:bg-emerald-950/40', icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-50 dark:bg-red-950/40', icon: AlertCircle },
  skipped: { label: 'Skipped', color: 'text-gray-500 dark:text-gray-400', bgColor: 'bg-gray-50 dark:bg-gray-950/40', icon: AlertCircle },
}

const PLATFORM_LABELS: Record<string, { label: string; color: string }> = {
  google_meet: { label: 'Google Meet', color: 'text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/40' },
  zoom: { label: 'Zoom', color: 'text-blue-700 bg-blue-50 dark:text-blue-400 dark:bg-blue-950/40' },
  teams: { label: 'Teams', color: 'text-violet-700 bg-violet-50 dark:text-violet-400 dark:bg-violet-950/40' },
}

type FilterType = 'all' | 'upcoming' | 'completed'

function getRelativeDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  if (diffMs < 0) {
    const absDays = Math.abs(diffDays)
    if (absDays === 0) return 'Today'
    if (absDays === 1) return 'Yesterday'
    return `${absDays} days ago`
  }

  if (diffHours < 1) return 'Starting soon'
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays < 7) return `In ${diffDays} days`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function MeetingsPage() {
  const supabase = createClient() as any
  const [meetings, setMeetings] = useState<MeetingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterType>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const loadMeetings = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase
        .from('meetings')
        .select('id, title, platform, scheduled_start, duration_seconds, status, participants, summary_ready, created_at')
        .order('scheduled_start', { ascending: true })
        .limit(50)

      if (filter === 'upcoming') {
        query = query.in('status', ['scheduled', 'joining', 'recording'])
      } else if (filter === 'completed') {
        query = query.eq('status', 'completed')
      }

      const { data, error } = await query
      if (error) throw error
      setMeetings((data || []) as unknown as MeetingRow[])
    } catch (err) {
      console.error('Failed to load meetings:', err)
    } finally {
      setLoading(false)
    }
  }, [supabase, filter])

  useEffect(() => {
    loadMeetings()
  }, [loadMeetings])

  const filteredMeetings = searchQuery
    ? meetings.filter(m => m.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : meetings

  const filters: { key: FilterType; label: string; count?: number }[] = [
    { key: 'all', label: 'All Meetings' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'completed', label: 'Completed' },
  ]

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Video className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
            <p className="text-sm text-muted-foreground">
              Recorded meetings with AI-powered summaries and action items
            </p>
          </div>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="mb-6 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
          <input
            type="text"
            placeholder="Search meetings..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-colors"
          />
        </div>
        <div className="flex gap-1 p-0.5 rounded-lg bg-muted/60">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                filter === f.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Meeting List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      ) : filteredMeetings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 px-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/60 mb-4">
            <Video className="h-6 w-6 text-muted-foreground/40" />
          </div>
          <p className="text-sm font-medium text-foreground/70 mb-1">No meetings found</p>
          <p className="text-xs text-muted-foreground text-center max-w-xs">
            {searchQuery
              ? 'Try a different search term.'
              : filter === 'upcoming'
                ? 'No upcoming meetings scheduled.'
                : 'Meetings will appear here once your calendar is synced and the bot starts recording.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredMeetings.map((meeting) => {
            const statusConfig = STATUS_CONFIG[meeting.status]
            const StatusIcon = statusConfig.icon
            const isSpinning = ['joining', 'transcribing', 'processing'].includes(meeting.status)
            const date = meeting.scheduled_start ? new Date(meeting.scheduled_start) : null
            const duration = meeting.duration_seconds
              ? `${Math.round(meeting.duration_seconds / 60)} min`
              : null
            const platform = meeting.platform ? PLATFORM_LABELS[meeting.platform] : null
            const relativeDate = meeting.scheduled_start ? getRelativeDate(meeting.scheduled_start) : null

            return (
              <Link key={meeting.id} href={`/meetings/${meeting.id}`}>
                <div className="group relative flex items-center gap-4 px-4 py-3.5 rounded-xl border border-border/60 bg-card hover:bg-accent/30 hover:border-border transition-all cursor-pointer">
                  {/* Left accent for live meetings */}
                  {meeting.status === 'recording' && (
                    <div className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-red-500 animate-pulse" />
                  )}

                  {/* Platform icon */}
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${statusConfig.bgColor}`}>
                    {meeting.status === 'recording' ? (
                      <div className="relative">
                        <Mic className={`h-4.5 w-4.5 ${statusConfig.color}`} />
                        <div className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                      </div>
                    ) : meeting.summary_ready ? (
                      <Sparkles className="h-4.5 w-4.5 text-primary" />
                    ) : (
                      <Video className={`h-4.5 w-4.5 ${meeting.status === 'completed' ? 'text-emerald-500' : 'text-muted-foreground/60'}`} />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                        {meeting.title}
                      </p>
                      {platform && (
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${platform.color}`}>
                          {platform.label}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {date && (
                        <span className="flex items-center gap-1">
                          <CalendarDays className="h-3 w-3" />
                          {date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                          {' '}
                          {date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      )}
                      {duration && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {duration}
                        </span>
                      )}
                      {meeting.participants.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {meeting.participants.length} participant{meeting.participants.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right side: relative time + status */}
                  <div className="flex items-center gap-3 shrink-0">
                    {relativeDate && (
                      <span className="text-[11px] text-muted-foreground/70 hidden sm:block">
                        {relativeDate}
                      </span>
                    )}
                    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium ${statusConfig.bgColor} ${statusConfig.color}`}>
                      <StatusIcon className={`h-3 w-3 ${isSpinning ? 'animate-spin' : ''}`} />
                      {statusConfig.label}
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-primary/60 transition-colors hidden sm:block" />
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
