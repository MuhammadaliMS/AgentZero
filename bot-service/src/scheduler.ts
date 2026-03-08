/**
 * Meeting Scheduler
 *
 * Polls Supabase for meetings that are:
 * - status = 'scheduled'
 * - starting within the next N minutes
 *
 * For each upcoming meeting, spawns a bot instance to join it.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from './config.js'
import { MeetingBot } from './bot.js'

interface ScheduledMeeting {
  id: string
  org_id: string
  title: string
  meeting_url: string
  platform: string | null
  scheduled_start: string
  participants: Array<{ name: string; email: string }>
}

export class MeetingScheduler {
  private supabase: SupabaseClient
  private activeBots: Map<string, MeetingBot> = new Map()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.supabase = createClient(config.supabaseUrl, config.supabaseServiceKey)
  }

  start(): void {
    console.log(`[scheduler] Starting meeting scheduler (poll every ${config.pollIntervalMs}ms)`)

    // Initial poll immediately
    this.poll()

    // Then poll on interval
    this.pollTimer = setInterval(() => this.poll(), config.pollIntervalMs)
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    // Stop all active bots
    for (const [meetingId, bot] of this.activeBots) {
      console.log(`[scheduler] Stopping bot for meeting ${meetingId}`)
      bot.leave().catch(err => {
        console.error(`[scheduler] Error stopping bot ${meetingId}:`, err)
      })
    }

    this.activeBots.clear()
    console.log('[scheduler] Scheduler stopped')
  }

  private async poll(): Promise<void> {
    try {
      // Find meetings starting within joinBeforeMinutes
      const now = new Date()
      const cutoff = new Date(now.getTime() + config.joinBeforeMinutes * 60 * 1000)

      const { data: meetings, error } = await this.supabase
        .from('meetings')
        .select('id, org_id, title, meeting_url, platform, scheduled_start, participants')
        .eq('status', 'scheduled')
        .not('meeting_url', 'is', null)
        .lte('scheduled_start', cutoff.toISOString())
        .gte('scheduled_start', new Date(now.getTime() - 30 * 60 * 1000).toISOString()) // Not older than 30min
        .order('scheduled_start', { ascending: true })
        .limit(10)

      if (error) {
        console.error('[scheduler] Poll error:', error.message)
        return
      }

      if (!meetings || meetings.length === 0) return

      for (const meeting of meetings as ScheduledMeeting[]) {
        // Skip if already handling this meeting
        if (this.activeBots.has(meeting.id)) continue

        // Check concurrent bot limit
        if (this.activeBots.size >= config.maxConcurrentBots) {
          console.warn(`[scheduler] Concurrent limit reached (${config.maxConcurrentBots}). Skipping ${meeting.title}`)
          break
        }

        // Spawn bot for this meeting
        console.log(`[scheduler] Joining meeting: ${meeting.title} (${meeting.id.slice(0, 8)})`)
        await this.spawnBot(meeting)
      }
    } catch (err) {
      console.error('[scheduler] Poll failed:', (err as Error).message)
    }
  }

  private async spawnBot(meeting: ScheduledMeeting): Promise<void> {
    // Mark meeting as joining
    await this.supabase
      .from('meetings')
      .update({
        status: 'joining',
        actual_start: new Date().toISOString(),
        bot_session_id: `bot-${process.pid}-${Date.now()}`,
      })
      .eq('id', meeting.id)

    const bot = new MeetingBot(meeting.id, meeting.meeting_url, meeting.platform, meeting.title)

    this.activeBots.set(meeting.id, bot)

    // Run bot lifecycle (non-blocking)
    bot.run()
      .then(async (result) => {
        console.log(`[scheduler] Bot finished for ${meeting.title}: ${result.status}`)

        if (result.status === 'recorded') {
          // Update status + notify webhook
          await this.supabase
            .from('meetings')
            .update({ status: 'transcribing' })
            .eq('id', meeting.id)

          // Notify webhook that recording is complete
          await this.notifyWebhook(meeting.id, 'recording_complete', {
            recording_path: result.recordingPath,
            video_path: result.videoPath,
            duration_seconds: result.durationSeconds,
          })

          // Run transcription with speaker timeline + captions
          await this.runTranscription(
            meeting.id,
            result.recordingPath!,
            result.speakerTimelinePath,
            result.transcriptPath,
          )
        } else {
          // Bot returned 'failed' or 'no_audio' — mark the meeting so scheduler doesn't retry endlessly
          console.warn(`[scheduler] Bot finished with status: ${result.status} — ${result.error || 'no details'}`)
          await this.supabase
            .from('meetings')
            .update({
              status: 'failed',
              actual_end: new Date().toISOString(),
              skip_reason: result.error || `Bot finished with status: ${result.status}`,
            })
            .eq('id', meeting.id)
          await this.notifyWebhook(meeting.id, 'bot_error', {
            error_message: result.error || `Bot status: ${result.status}`,
          })
        }
      })
      .catch(async (err) => {
        console.error(`[scheduler] Bot error for ${meeting.title}:`, (err as Error).message)
        await this.supabase
          .from('meetings')
          .update({
            status: 'failed',
            actual_end: new Date().toISOString(),
            skip_reason: (err as Error).message,
          })
          .eq('id', meeting.id)
        await this.notifyWebhook(meeting.id, 'bot_error', {
          error_message: (err as Error).message,
        })
      })
      .finally(() => {
        this.activeBots.delete(meeting.id)
      })
  }

  private async runTranscription(
    meetingId: string,
    recordingPath: string,
    speakerTimelinePath?: string,
    captionsPath?: string,
  ): Promise<void> {
    const { spawn } = await import('child_process')

    console.log(`[scheduler] Starting transcription for ${meetingId}`)

    const args = [
      config.transcribeScript,
      recordingPath,
      '--meeting-id', meetingId,
      '--engine', config.transcriptionEngine,
    ]

    // Pass speaker timeline if available (real names from DOM tracking)
    if (speakerTimelinePath) {
      args.push('--speaker-timeline', speakerTimelinePath)
    }

    // Pass captions if available (can skip Groq entirely!)
    if (captionsPath) {
      args.push('--captions', captionsPath)
    }

    const proc = spawn('python3', args, {
      env: {
        ...process.env,
        SUPABASE_URL: config.supabaseUrl,
        SUPABASE_SERVICE_KEY: config.supabaseServiceKey,
        GROQ_API_KEY: config.groqApiKey,
        WEBHOOK_URL: config.webhookUrl,
        WEBHOOK_AUTH_TOKEN: config.webhookAuthToken,
      },
      stdio: 'pipe',
    })

    proc.stdout?.on('data', (data: Buffer) => {
      process.stdout.write(`[transcribe/${meetingId.slice(0, 8)}] ${data}`)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[transcribe/${meetingId.slice(0, 8)}] ${data}`)
    })

    proc.on('close', async (code) => {
      if (code === 0) {
        console.log(`[scheduler] Transcription completed for ${meetingId}`)
        // Update meeting status to completed
        await this.supabase
          .from('meetings')
          .update({
            status: 'completed',
            actual_end: new Date().toISOString(),
          })
          .eq('id', meetingId)
      } else {
        console.error(`[scheduler] Transcription failed with code ${code} for ${meetingId}`)
        await this.supabase
          .from('meetings')
          .update({
            status: 'failed',
            actual_end: new Date().toISOString(),
            skip_reason: `Transcription process exited with code ${code}`,
          })
          .eq('id', meetingId)
        this.notifyWebhook(meetingId, 'bot_error', {
          error_message: `Transcription process exited with code ${code}`,
        })
      }
    })
  }

  private async notifyWebhook(
    meetingId: string,
    event: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.webhookAuthToken}`,
        },
        body: JSON.stringify({ meeting_id: meetingId, event, ...extra }),
      })

      if (!response.ok) {
        console.error(`[scheduler] Webhook failed (${response.status}):`, await response.text())
      }
    } catch (err) {
      console.error(`[scheduler] Webhook error:`, (err as Error).message)
    }
  }
}
