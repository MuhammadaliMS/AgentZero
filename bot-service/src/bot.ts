/**
 * Meeting Bot
 *
 * Uses Puppeteer to join a Google Meet / Zoom meeting.
 * Captures audio (PulseAudio) + video (Xvfb screen capture) + active speaker names (DOM).
 *
 * Architecture:
 *   1. Launch headless Chromium on Xvfb virtual display
 *   2. Navigate to meeting URL, join meeting
 *   3. Start audio recording (PulseAudio → ffmpeg → .webm)
 *   4. Start video recording (Xvfb screen → ffmpeg → .mp4)
 *   5. Poll DOM every 2s for active speaker indicator → build speaker timeline
 *   6. Try to enable/scrape captions as bonus (not required)
 *   7. Monitor for meeting end
 *   8. Stop recording, save speaker timeline JSON
 *   9. Transcription runs separately via transcribe.py (Groq Whisper + speaker timeline)
 */

import puppeteer, { type Browser, type Page } from 'puppeteer'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'

interface BotResult {
  status: 'recorded' | 'failed' | 'no_audio'
  recordingPath?: string
  videoPath?: string
  speakerTimelinePath?: string
  transcriptPath?: string
  durationSeconds?: number
  error?: string
}

interface SpeakerEvent {
  speaker: string      // Actual participant name from DOM
  startTime: number    // Seconds from recording start
  endTime: number      // Updated when next speaker starts
}

interface CaptionSegment {
  speaker: string
  text: string
  startTime: number
  endTime: number
}

export class MeetingBot {
  private meetingId: string
  private meetingUrl: string
  private platform: string | null
  private title: string
  private browser: Browser | null = null
  private page: Page | null = null
  private audioProcess: ChildProcess | null = null
  private videoProcess: ChildProcess | null = null
  private recordingPath: string
  private videoPath: string
  private speakerTimelinePath: string
  private transcriptPath: string
  private startTime: number = 0
  private shouldStop = false

  // Speaker tracking
  private speakerTimeline: SpeakerEvent[] = []
  private currentSpeaker: string = ''
  private participants: Set<string> = new Set()

  // Bonus caption scraping
  private captionSegments: CaptionSegment[] = []
  private lastCaptionKey: string = ''
  private captionsEnabled: boolean = false

  constructor(meetingId: string, meetingUrl: string, platform: string | null, title: string) {
    this.meetingId = meetingId
    this.meetingUrl = meetingUrl
    this.platform = platform
    this.title = title

    mkdirSync(config.recordingDir, { recursive: true })
    this.recordingPath = join(config.recordingDir, `${meetingId}.webm`)
    this.videoPath = join(config.recordingDir, `${meetingId}.mp4`)
    this.speakerTimelinePath = join(config.recordingDir, `${meetingId}_speakers.json`)
    this.transcriptPath = join(config.recordingDir, `${meetingId}_captions.json`)
  }

  async run(): Promise<BotResult> {
    try {
      await this.launchBrowser()

      const joined = await this.joinMeeting()
      if (!joined) {
        return { status: 'failed', error: 'Could not join meeting' }
      }

      // Try to enable captions (best-effort, not required)
      await this.tryEnableCaptions()

      // Start both audio + video recording
      this.startAudioRecording()
      this.startVideoRecording()
      this.startTime = Date.now()

      console.log(`[bot/${this.meetingId.slice(0, 8)}] Recording started (audio + video + speaker tracking) for "${this.title}"`)

      // Monitor meeting: check end, scrape speakers, scrape captions
      await this.monitorMeeting()

      // Stop everything
      this.stopAudioRecording()
      this.stopVideoRecording()
      this.saveSpeakerTimeline()
      if (this.captionSegments.length > 0) this.saveCaptions()

      const durationSeconds = Math.round((Date.now() - this.startTime) / 1000)

      if (!existsSync(this.recordingPath)) {
        return { status: 'no_audio', error: 'Recording file not created' }
      }

      const speakers = [...this.participants]
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Done: ${durationSeconds}s, ${this.speakerTimeline.length} speaker events, ${speakers.length} participants: ${speakers.join(', ')}`)

      return {
        status: 'recorded',
        recordingPath: this.recordingPath,
        videoPath: existsSync(this.videoPath) ? this.videoPath : undefined,
        speakerTimelinePath: this.speakerTimelinePath,
        transcriptPath: this.captionSegments.length > 0 ? this.transcriptPath : undefined,
        durationSeconds,
      }
    } catch (err) {
      return { status: 'failed', error: (err as Error).message }
    } finally {
      await this.cleanup()
    }
  }

  async leave(): Promise<void> {
    this.shouldStop = true
    this.stopAudioRecording()
    this.stopVideoRecording()
    await this.cleanup()
  }

  // ─── Browser Launch ──────────────────────────────────────────────────

  private async launchBrowser(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-features=PulseAudioLoopbackForScreenCapture',
        '--window-size=1280,720',
      ],
      env: {
        ...process.env,
        PULSE_SINK: 'virtual_sink',
        DISPLAY: process.env.DISPLAY || ':99',
      },
    })

    this.page = await this.browser.newPage()
    await this.page.setViewport({ width: 1280, height: 720 })

    const context = this.browser.defaultBrowserContext()
    await context.overridePermissions(this.meetingUrl, ['microphone'])
  }

  // ─── Join Meeting ────────────────────────────────────────────────────

  private async joinMeeting(): Promise<boolean> {
    if (!this.page) return false

    if (this.platform === 'google_meet' || this.meetingUrl.includes('meet.google.com')) {
      return this.joinGoogleMeet()
    } else if (this.platform === 'zoom' || this.meetingUrl.includes('zoom.us')) {
      return this.joinZoom()
    } else {
      console.warn(`[bot/${this.meetingId.slice(0, 8)}] Unknown platform, trying Google Meet flow`)
      return this.joinGoogleMeet()
    }
  }

  private async joinGoogleMeet(): Promise<boolean> {
    if (!this.page) return false

    try {
      await this.page.goto(this.meetingUrl, { waitUntil: 'networkidle2', timeout: 30000 })
      await this.sleep(3000)

      // Turn off camera
      try {
        const cam = await this.page.$('[data-is-muted][aria-label*="camera" i]')
          || await this.page.$('[aria-label*="Turn off camera" i]')
          || await this.page.$('[data-tooltip*="camera" i]')
        if (cam) await cam.click()
      } catch { /* already off */ }
      await this.sleep(1000)

      // Turn off mic
      try {
        const mic = await this.page.$('[data-is-muted][aria-label*="microphone" i]')
          || await this.page.$('[aria-label*="Turn off microphone" i]')
          || await this.page.$('[data-tooltip*="microphone" i]')
        if (mic) await mic.click()
      } catch { /* already off */ }
      await this.sleep(1000)

      // Dismiss dialogs
      try {
        for (const btn of await this.page.$$('button')) {
          const text = await btn.evaluate((el: Element) => el.textContent?.trim().toLowerCase())
          if (text === 'got it' || text === 'dismiss') {
            await btn.click()
            await this.sleep(500)
          }
        }
      } catch { /* no dialogs */ }

      // Enter name if prompted
      try {
        const nameInput = await this.page.$('input[aria-label*="name" i]')
          || await this.page.$('input[placeholder*="name" i]')
        if (nameInput) {
          await nameInput.click({ clickCount: 3 })
          await nameInput.type('Captain (Meeting Bot)')
          await this.sleep(500)
        }
      } catch { /* no name prompt */ }

      // Click join button
      let joined = false
      for (const sel of ['button[data-idom-class*="join"]', '[aria-label*="Join now" i]', '[aria-label*="Ask to join" i]']) {
        try {
          const btn = await this.page.$(sel)
          if (btn) { await btn.click(); joined = true; break }
        } catch { /* try next */ }
      }

      if (!joined) {
        for (const btn of await this.page.$$('button, [role="button"]')) {
          const text = await btn.evaluate((el: Element) => el.textContent?.trim().toLowerCase() || '')
          if (text.includes('join now') || text.includes('ask to join') || text === 'join') {
            await btn.click()
            joined = true
            break
          }
        }
      }

      if (!joined) {
        console.error(`[bot/${this.meetingId.slice(0, 8)}] Could not find join button`)
        return false
      }

      // Wait for admission — Google Meet shows "Ask to join" when not auto-admitted.
      // We poll for up to 120 seconds (2 min) to see if we get into the actual meeting.
      // Signs we're admitted: meeting controls appear (mic/camera/end-call buttons in-call),
      // or the "Asking to be let in" / "Waiting for someone to let you in" text disappears.
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Waiting for admission to Google Meet...`)

      const admissionTimeout = 120_000 // 2 minutes
      const admissionPoll = 3_000     // check every 3s
      let waited = 0
      let admitted = false

      while (waited < admissionTimeout) {
        await this.sleep(admissionPoll)
        waited += admissionPoll

        try {
          const status = await this.page.evaluate(() => {
            const bodyText = document.body.innerText.toLowerCase()

            // If we see "waiting" or "asking to be let in", we're not admitted yet
            if (bodyText.includes('asking to be let in') ||
                bodyText.includes('waiting for someone') ||
                bodyText.includes('someone in the meeting needs to let you in')) {
              return 'waiting'
            }

            // If we see end-call / leave-call controls, we're in the meeting
            const endCallBtn = document.querySelector('[aria-label*="Leave call" i]')
              || document.querySelector('[aria-label*="End call" i]')
              || document.querySelector('[data-tooltip*="Leave call" i]')
            if (endCallBtn) return 'admitted'

            // If we see meeting participants or chat panel, we're in
            const inCallIndicators = document.querySelector('[data-participant-id]')
              || document.querySelector('[aria-label*="people" i][aria-label*="call" i]')
            if (inCallIndicators) return 'admitted'

            // If we see the "you've been removed" or meeting ended text
            if (bodyText.includes('you left the meeting') ||
                bodyText.includes('the meeting has ended') ||
                bodyText.includes('removed from the meeting')) {
              return 'ended'
            }

            // After first 5 seconds, if no waiting text found, assume we got in directly
            return 'unknown'
          })

          if (status === 'admitted') {
            admitted = true
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Admitted to Google Meet after ${waited / 1000}s`)
            break
          }

          if (status === 'ended') {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Meeting ended while waiting for admission`)
            return false
          }

          if (status === 'unknown' && waited >= 10_000) {
            // After 10s with no "waiting" text, assume we joined directly (no admission needed)
            admitted = true
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Appears to have joined directly (no admission gate detected)`)
            break
          }

          if (waited % 15_000 < admissionPoll) {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Still waiting for admission... (${waited / 1000}s)`)
          }
        } catch {
          // If page evaluation fails, we may have been redirected into the meeting
          admitted = true
          break
        }
      }

      if (!admitted) {
        console.error(`[bot/${this.meetingId.slice(0, 8)}] Admission timed out after ${admissionTimeout / 1000}s — nobody let the bot in`)
        return false
      }

      await this.sleep(2000) // Brief settle after admission
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Joined Google Meet: ${this.title}`)
      return true
    } catch (err) {
      console.error(`[bot/${this.meetingId.slice(0, 8)}] Google Meet join failed:`, (err as Error).message)
      return false
    }
  }

  private async joinZoom(): Promise<boolean> {
    if (!this.page) return false

    try {
      let url = this.meetingUrl
      if (!url.includes('from=addon')) url += (url.includes('?') ? '&' : '?') + 'from=addon'

      await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
      await this.sleep(3000)

      for (const link of await this.page.$$('a')) {
        const text = await link.evaluate((el: Element) => el.textContent?.trim().toLowerCase() || '')
        if (text.includes('join from your browser') || text.includes('join from browser')) {
          await link.click()
          await this.sleep(3000)
          break
        }
      }

      try {
        const nameInput = await this.page.$('#inputname') || await this.page.$('input[name="inputname"]')
        if (nameInput) { await nameInput.click({ clickCount: 3 }); await nameInput.type('Captain (Meeting Bot)') }
      } catch { /* no name prompt */ }

      try {
        const joinBtn = await this.page.$('#joinBtn') || await this.page.$('button.zm-btn-primary')
        if (joinBtn) await joinBtn.click()
      } catch { /* join button not found */ }

      await this.sleep(5000)

      try {
        for (const btn of await this.page.$$('button')) {
          const text = await btn.evaluate((el: Element) => el.textContent?.trim().toLowerCase() || '')
          if (text.includes('join audio by computer') || text.includes('computer audio')) {
            await btn.click()
            break
          }
        }
      } catch { /* no audio prompt */ }

      console.log(`[bot/${this.meetingId.slice(0, 8)}] Joined Zoom: ${this.title}`)
      return true
    } catch (err) {
      console.error(`[bot/${this.meetingId.slice(0, 8)}] Zoom join failed:`, (err as Error).message)
      return false
    }
  }

  // ─── Audio Recording (PulseAudio) ──────────────────────────────────────

  private startAudioRecording(): void {
    this.audioProcess = spawn('bash', ['-c', `
      parec --format=s16le --rate=16000 --channels=1 \
        --device=virtual_sink.monitor | \
      ffmpeg -f s16le -ar 16000 -ac 1 -i pipe:0 \
        -c:a libopus -b:a 48k \
        -y "${this.recordingPath}" \
        2>/dev/null
    `], { stdio: ['pipe', 'pipe', 'pipe'] })

    this.audioProcess.on('error', (err) => {
      console.error(`[bot/${this.meetingId.slice(0, 8)}] Audio recording error:`, err.message)
    })
  }

  private stopAudioRecording(): void {
    if (this.audioProcess && !this.audioProcess.killed) {
      this.audioProcess.kill('SIGINT')
      setTimeout(() => {
        if (this.audioProcess && !this.audioProcess.killed) this.audioProcess.kill('SIGKILL')
      }, 5000)
    }
  }

  // ─── Video Recording (Xvfb Screen Capture) ─────────────────────────────

  private startVideoRecording(): void {
    const display = process.env.DISPLAY || ':99'
    // Capture the virtual display at 5fps (low CPU, good enough for meetings)
    this.videoProcess = spawn('ffmpeg', [
      '-f', 'x11grab',
      '-video_size', '1280x720',
      '-framerate', '5',
      '-i', display,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',             // Decent quality, small file
      '-pix_fmt', 'yuv420p',
      '-y', this.videoPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    this.videoProcess.on('error', (err) => {
      console.warn(`[bot/${this.meetingId.slice(0, 8)}] Video recording error (non-fatal):`, err.message)
    })

    console.log(`[bot/${this.meetingId.slice(0, 8)}] Video recording started (5fps, ${display})`)
  }

  private stopVideoRecording(): void {
    if (this.videoProcess && !this.videoProcess.killed) {
      // Send 'q' to stdin for graceful ffmpeg stop
      this.videoProcess.stdin?.write('q')
      setTimeout(() => {
        if (this.videoProcess && !this.videoProcess.killed) this.videoProcess.kill('SIGINT')
      }, 3000)
      setTimeout(() => {
        if (this.videoProcess && !this.videoProcess.killed) this.videoProcess.kill('SIGKILL')
      }, 6000)
    }
  }

  // ─── Active Speaker Detection (DOM) ────────────────────────────────────

  private async detectActiveSpeaker(): Promise<void> {
    if (!this.page) return

    try {
      const isGoogleMeet = this.platform === 'google_meet' || this.meetingUrl.includes('meet.google.com')
      const speaker = isGoogleMeet
        ? await this.detectGoogleMeetSpeaker()
        : await this.detectZoomSpeaker()

      if (speaker && speaker !== 'Captain (Meeting Bot)') {
        this.participants.add(speaker)

        if (speaker !== this.currentSpeaker) {
          const elapsed = (Date.now() - this.startTime) / 1000

          // Finalize previous speaker's end time
          if (this.speakerTimeline.length > 0) {
            this.speakerTimeline[this.speakerTimeline.length - 1].endTime = elapsed
          }

          this.speakerTimeline.push({
            speaker,
            startTime: elapsed,
            endTime: elapsed, // Will be updated
          })

          this.currentSpeaker = speaker
        }
      }
    } catch {
      // Best-effort, don't crash the bot
    }
  }

  private async detectGoogleMeetSpeaker(): Promise<string | null> {
    if (!this.page) return null

    return this.page.evaluate(() => {
      // Google Meet highlights the active speaker's video tile with a blue/colored border
      // Method 1: Look for the "speaking" indicator on participant tiles
      // The active speaker typically has a colored border or animation around their tile

      // Check for active speaker indicator via data attributes
      const speakingEl = document.querySelector('[data-self-name][data-is-speaking="true"]')
        || document.querySelector('[data-participant-id][data-is-speaking="true"]')
      if (speakingEl) {
        return speakingEl.getAttribute('data-self-name')
          || speakingEl.querySelector('[data-self-name]')?.getAttribute('data-self-name')
          || null
      }

      // Method 2: Look for the participant name near an active visual indicator
      // Google Meet uses a blue border (2px+) on the active speaker's tile
      const tiles = document.querySelectorAll('[data-participant-id], [data-requested-participant-id]')
      for (const tile of tiles) {
        const style = window.getComputedStyle(tile)
        const border = style.borderColor || ''
        const outline = style.outlineColor || ''
        // Active speaker has a blue/accent border
        if (border.includes('rgb(26, 115, 232)') || border.includes('#1a73e8') ||
            outline.includes('rgb(26, 115, 232)') || border.includes('rgb(66, 133, 244)')) {
          // Find name within the tile
          const nameEl = tile.querySelector('[data-self-name]')
          if (nameEl) return nameEl.getAttribute('data-self-name')

          // Or look for a text element with the participant name
          const nameText = tile.querySelector('[class*="ZjFb7c"], [class*="cS7aqe"]')
          if (nameText?.textContent) return nameText.textContent.trim()
        }
      }

      // Method 3: Look at the "pinned" or large video (usually the speaker)
      const pinnedName = document.querySelector('[data-self-name][data-is-main-screen="true"]')
      if (pinnedName) return pinnedName.getAttribute('data-self-name')

      // Method 4: Caption indicator (if captions happen to be on)
      const captionSpeaker = document.querySelector('[data-sender-name]')
      if (captionSpeaker) return captionSpeaker.getAttribute('data-sender-name')

      return null
    })
  }

  private async detectZoomSpeaker(): Promise<string | null> {
    if (!this.page) return null

    return this.page.evaluate(() => {
      // Zoom highlights active speaker with green border
      // Method 1: Active speaker border
      const activeTile = document.querySelector('.speaker-active-container, [class*="active-speaker"]')
      if (activeTile) {
        const nameEl = activeTile.querySelector('[class*="display-name"], [class*="participant-name"]')
        if (nameEl?.textContent) return nameEl.textContent.trim()
      }

      // Method 2: Speaker name in header/spotlight
      const spotlight = document.querySelector('.speaker-bar-container [class*="name"], .active-speaker [class*="name"]')
      if (spotlight?.textContent) return spotlight.textContent.trim()

      // Method 3: Check for green border on video tiles
      const tiles = document.querySelectorAll('.video-avatar, [class*="participant"]')
      for (const tile of tiles) {
        const style = window.getComputedStyle(tile)
        if (style.borderColor?.includes('rgb(0, 128') || style.borderColor?.includes('green')) {
          const nameEl = tile.querySelector('[class*="name"]')
          if (nameEl?.textContent) return nameEl.textContent.trim()
        }
      }

      return null
    })
  }

  // ─── Bonus: Caption Scraping (if captions are on) ──────────────────────

  private async tryEnableCaptions(): Promise<void> {
    if (!this.page) return
    try {
      const isGoogleMeet = this.platform !== 'zoom' && !this.meetingUrl.includes('zoom.us')

      if (isGoogleMeet) {
        // Try clicking the CC button
        for (const sel of ['[aria-label*="captions" i]', '[aria-label*="subtitles" i]', '[data-tooltip*="captions" i]']) {
          const btn = await this.page.$(sel)
          if (btn) {
            await btn.click()
            await this.sleep(1000)
            this.captionsEnabled = true
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Captions enabled (bonus)`)
            return
          }
        }
      } else {
        for (const sel of ['[aria-label*="live transcript" i]', '[aria-label*="closed caption" i]', '[aria-label*="captions" i]']) {
          const btn = await this.page.$(sel)
          if (btn) {
            await btn.click()
            await this.sleep(1000)
            this.captionsEnabled = true
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Zoom captions enabled (bonus)`)
            return
          }
        }
      }
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Captions not available — will use audio transcription via Groq`)
    } catch {
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Could not enable captions — will use Groq`)
    }
  }

  private async scrapeCaptions(): Promise<void> {
    if (!this.page || !this.captionsEnabled) return

    try {
      const captions = await this.page.evaluate(() => {
        const results: { speaker: string; text: string }[] = []

        // Google Meet captions
        const senderEls = document.querySelectorAll('[data-sender-name]')
        for (const el of senderEls) {
          const speaker = el.getAttribute('data-sender-name') || 'Unknown'
          const text = el.textContent?.trim() || ''
          if (text) results.push({ speaker, text })
        }

        // Generic caption containers
        if (results.length === 0) {
          const containers = document.querySelectorAll('[class*="caption"], [class*="subtitle"]')
          for (const c of containers) {
            const text = c.textContent?.trim() || ''
            if (text.length > 2) results.push({ speaker: 'Unknown', text })
          }
        }

        return results
      })

      const elapsed = (Date.now() - this.startTime) / 1000
      for (const cap of captions) {
        const key = `${cap.speaker}:${cap.text}`
        if (key === this.lastCaptionKey) continue

        if (this.captionSegments.length > 0) {
          this.captionSegments[this.captionSegments.length - 1].endTime = elapsed
        }

        this.captionSegments.push({
          speaker: cap.speaker,
          text: cap.text,
          startTime: elapsed,
          endTime: elapsed,
        })
        this.lastCaptionKey = key
      }
    } catch { /* best-effort */ }
  }

  // ─── Meeting Monitor ──────────────────────────────────────────────────

  private async monitorMeeting(): Promise<void> {
    const MAX_DURATION_MS = 4 * 60 * 60 * 1000
    const POLL_MS = 2000        // Every 2 seconds: detect speaker + scrape captions
    const END_CHECK_MS = 15000  // Every 15 seconds: check if meeting ended

    let elapsed = 0
    let lastEndCheck = 0

    while (!this.shouldStop && elapsed < MAX_DURATION_MS) {
      await this.sleep(POLL_MS)
      elapsed += POLL_MS

      // Detect active speaker from DOM
      await this.detectActiveSpeaker()

      // Scrape captions if available
      await this.scrapeCaptions()

      // Check for meeting end every 15s
      if (elapsed - lastEndCheck >= END_CHECK_MS) {
        lastEndCheck = elapsed
        if (await this.isMeetingEnded()) {
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Meeting ended`)
          return
        }
      }

      // Log progress every 5 min
      if (elapsed % (5 * 60 * 1000) < POLL_MS) {
        const mins = Math.round(elapsed / 60000)
        console.log(`[bot/${this.meetingId.slice(0, 8)}] Recording... ${mins}min, ${this.speakerTimeline.length} speaker events, ${this.participants.size} participants`)
      }
    }

    if (elapsed >= MAX_DURATION_MS) {
      console.warn(`[bot/${this.meetingId.slice(0, 8)}] Max duration (4h) reached.`)
    }
  }

  private async isMeetingEnded(): Promise<boolean> {
    if (!this.page) return true
    try {
      const pageContent = await this.page.evaluate(() => document.body.innerText)
      const endPhrases = [
        'you left the meeting', "you've left the meeting", 'the meeting has ended',
        'the call has ended', 'return to home screen', 'removed from the meeting', 'meeting ended',
      ]
      const lower = pageContent.toLowerCase()
      for (const phrase of endPhrases) {
        if (lower.includes(phrase)) return true
      }
      if (this.page.isClosed()) return true
      return false
    } catch {
      return true
    }
  }

  // ─── Save Data ────────────────────────────────────────────────────────

  private saveSpeakerTimeline(): void {
    // Finalize last event
    if (this.speakerTimeline.length > 0) {
      this.speakerTimeline[this.speakerTimeline.length - 1].endTime = (Date.now() - this.startTime) / 1000
    }

    const data = {
      meetingId: this.meetingId,
      title: this.title,
      platform: this.platform,
      recordedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - this.startTime) / 1000),
      participants: [...this.participants],
      speakerEvents: this.speakerTimeline,
    }

    writeFileSync(this.speakerTimelinePath, JSON.stringify(data, null, 2))
  }

  private saveCaptions(): void {
    // Merge consecutive same-speaker captions
    const merged: CaptionSegment[] = []
    for (const seg of this.captionSegments) {
      const last = merged[merged.length - 1]
      if (last && last.speaker === seg.speaker && (seg.startTime - last.endTime) < 3) {
        last.text = `${last.text} ${seg.text}`
        last.endTime = seg.endTime
      } else {
        merged.push({ ...seg })
      }
    }

    const data = {
      meetingId: this.meetingId,
      source: 'live_captions',
      segments: merged,
    }

    writeFileSync(this.transcriptPath, JSON.stringify(data, null, 2))
    console.log(`[bot/${this.meetingId.slice(0, 8)}] Captions saved: ${merged.length} segments`)
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  private async cleanup(): Promise<void> {
    this.stopAudioRecording()
    this.stopVideoRecording()

    if (this.page && !this.page.isClosed()) {
      try { await this.page.close() } catch { /* ignore */ }
    }
    if (this.browser) {
      try { await this.browser.close() } catch { /* ignore */ }
      this.browser = null
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
