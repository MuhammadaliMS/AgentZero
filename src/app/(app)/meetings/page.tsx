'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Mic, Clock, Users, CheckCircle2, AlertCircle, Loader2, Video, CalendarDays } from 'lucide-react'
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

const STATUS_CONFIG: Record<MeetingStatus, { label: string; variant: string; icon: React.ElementType }> = {
  scheduled: { label: 'Scheduled', variant: 'border-blue-500/50 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400', icon: CalendarDays },
  joining: { label: 'Joining', variant: 'border-yellow-500/50 bg-yellow-50 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-400', icon: Loader2 },
  recording: { label: 'Recording', variant: 'border-red-500/50 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400', icon: Mic },
  transcribing: { label: 'Transcribing', variant: 'border-purple-500/50 bg-purple-50 text-purple-700 dark:bg-purple-950/30 dark:text-purple-400', icon: Loader2 },
  processing: { label: 'Processing', variant: 'border-orange-500/50 bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-400', icon: Loader2 },
  completed: { label: 'Completed', variant: 'border-green-500/50 bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400', icon: CheckCircle2 },
  failed: { label: 'Failed', variant: 'border-red-500/50 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400', icon: AlertCircle },
  skipped: { label: 'Skipped', variant: 'border-gray-500/50 bg-gray-50 text-gray-700 dark:bg-gray-950/30 dark:text-gray-400', icon: AlertCircle },
}

export default function MeetingsPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- meeting tables not in generated types yet (run `supabase gen types` after applying migration 022)
  const supabase = createClient() as any
  const [meetings, setMeetings] = useState<MeetingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'upcoming' | 'completed'>('all')

  const loadMeetings = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase
        .from('meetings')
        .select('id, title, platform, scheduled_start, duration_seconds, status, participants, summary_ready, created_at')
        .order('scheduled_start', { ascending: false })
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

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Meetings</h1>
          <p className="text-sm text-muted-foreground">
            Your recorded meetings with AI summaries and action items.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 flex gap-2">
        {(['all', 'upcoming', 'completed'] as const).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>

      {/* Meeting List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : meetings.length === 0 ? (
        <Card className="shadow-sm">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Video className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No meetings found</p>
            <p className="text-xs text-muted-foreground mt-1">
              {filter === 'upcoming'
                ? 'No upcoming meetings scheduled.'
                : 'Meetings will appear here once your calendar is synced and the bot starts recording.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {meetings.map((meeting) => {
            const statusConfig = STATUS_CONFIG[meeting.status]
            const StatusIcon = statusConfig.icon
            const date = meeting.scheduled_start
              ? new Date(meeting.scheduled_start)
              : null
            const duration = meeting.duration_seconds
              ? `${Math.round(meeting.duration_seconds / 60)} min`
              : null

            return (
              <Link key={meeting.id} href={`/meetings/${meeting.id}`}>
                <Card className="shadow-sm transition-all hover:shadow-md hover:border-foreground/20 cursor-pointer">
                  <CardContent className="flex items-center gap-4 py-4">
                    {/* Meeting icon */}
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Mic className="h-4.5 w-4.5 text-muted-foreground" />
                    </div>

                    {/* Meeting info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{meeting.title}</p>
                        {meeting.platform && (
                          <Badge variant="secondary" className="text-[10px] shrink-0">
                            {meeting.platform === 'google_meet' ? 'Meet' : meeting.platform === 'zoom' ? 'Zoom' : 'Teams'}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
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
                            {meeting.participants.length}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Status badge */}
                    <Badge
                      variant="secondary"
                      className={`text-[10px] shrink-0 ${statusConfig.variant}`}
                    >
                      <StatusIcon className={`h-3 w-3 mr-1 ${meeting.status === 'joining' || meeting.status === 'transcribing' || meeting.status === 'processing' ? 'animate-spin' : ''}`} />
                      {statusConfig.label}
                    </Badge>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
