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

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { type Browser, type Page } from 'puppeteer'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import { DomAgent, type SpeakerPatterns } from './dom-agent.js'

// Enable stealth mode to bypass Google's bot detection
puppeteer.use(StealthPlugin())

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

  // Alone-in-meeting detection
  private aloneStartTime: number = 0
  private wasEverNotAlone: boolean = false

  // Bonus caption scraping
  private captionSegments: CaptionSegment[] = []
  private lastCaptionKey: string = ''
  private captionsEnabled: boolean = false

  // DOM Agent — LLM-powered DOM understanding
  private domAgent: DomAgent | null = null
  private discoveredPatterns: SpeakerPatterns | null = null
  private consecutiveNulls: number = 0
  private domAnalysisInProgress: boolean = false

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

      // Initialize DOM Agent if LLM API key is configured (NVIDIA NIM → OpenRouter fallback)
      if (config.domAgentEnabled && config.domAgentApiKey && this.page) {
        this.domAgent = new DomAgent(this.page, {
          apiKey: config.domAgentApiKey,
          model: config.domAgentModel,
          baseUrl: config.domAgentBaseUrl,
        })
        console.log(`[bot/${this.meetingId.slice(0, 8)}] DOM Agent initialized (${config.domAgentModel})`)
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

      // Check if recording is too short (likely empty meeting, not admitted, or instant end)
      if (durationSeconds < 30) {
        console.warn(`[bot/${this.meetingId.slice(0, 8)}] Recording too short (${durationSeconds}s) — likely never admitted or meeting ended immediately`)
        return { status: 'no_audio', error: `Recording too short: ${durationSeconds}s — bot may not have been admitted to the meeting` }
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
    // Use a persistent Chrome profile so Google login session survives across bot runs.
    // This eliminates the CAPTCHA/verification challenges that happen with fresh browsers.
    const chromeProfileDir = join(config.recordingDir, 'chrome_profile')
    mkdirSync(chromeProfileDir, { recursive: true })

    // Clean stale Chromium lock files from previous container runs
    // Without this, Chrome refuses to start with "profile appears to be in use"
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const lockPath = join(chromeProfileDir, lockFile)
      try { unlinkSync(lockPath) } catch { /* doesn't exist — fine */ }
    }

    this.browser = await puppeteer.launch({
      headless: false,  // Use Xvfb virtual display — looks like real browser to Google
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      userDataDir: chromeProfileDir,  // Persist cookies, localStorage, session data
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // Auto-grant media permissions (no popup) but use REAL PulseAudio devices
        // NOT --use-fake-device-for-media-stream (that exposes "Fake Default Audio Input" to Google)
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-features=PulseAudioLoopbackForScreenCapture',
        '--window-size=1280,720',
        '--disable-blink-features=AutomationControlled',
        // Additional anti-detection flags
        '--disable-features=TranslateUI',
        '--lang=en-US',
      ],
      env: {
        ...process.env,
        PULSE_SINK: 'virtual_sink',
        DISPLAY: process.env.DISPLAY || ':99',
      },
    })

    // Use the default page created with the browser (avoids extra blank tabs)
    const pages = await this.browser.pages()
    this.page = pages[0] || await this.browser.newPage()
    await this.page.setViewport({ width: 1280, height: 720 })

    // User agent MUST match the actual Chrome version in the Docker image
    // Mismatched versions are a strong bot detection signal
    await this.page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    )

    // Hide navigator.webdriver (Puppeteer sets this to true, which Google detects)
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      // Also hide automation-related properties
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],  // Non-empty plugins array
      })
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      })
      // Spoof chrome.runtime to look like a real Chrome
      ;(window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) }
    })

    const context = this.browser.defaultBrowserContext()
    await context.overridePermissions('https://meet.google.com', ['microphone', 'camera', 'notifications'])
  }

  // ─── Google Account Sign-In ─────────────────────────────────────────

  /**
   * Check if a Meet page indicates we're NOT signed into Google.
   * Call this AFTER navigating to the Meet URL.
   */
  private async isMeetPageGuest(): Promise<boolean> {
    if (!this.page) return true
    try {
      const pageContent = await this.page.evaluate(() => document.body.innerText.substring(0, 1500).toLowerCase())
      // Guest indicators: "What's your name?" input prompt, or "Sign in" link visible
      const isGuest = pageContent.includes("what's your name") ||
          pageContent.includes('what\u2019s your name') ||
          (pageContent.includes('sign in') && pageContent.includes('ask to join'))
      return isGuest
    } catch {
      return false
    }
  }

  /**
   * Check if we have an existing Google session in the persistent Chrome profile.
   * Returns true if authenticated, false if not.
   * Does NOT attempt fresh sign-in (that triggers CAPTCHA).
   */
  private async signInToGoogle(): Promise<boolean> {
    if (!this.page) return false

    try {
      await this.page.goto('https://accounts.google.com/', { waitUntil: 'networkidle2', timeout: 15000 })
      const url = this.page.url()

      const isSignInPage = url.includes('accounts.google.com/signin') ||
          url.includes('accounts.google.com/ServiceLogin') ||
          url.includes('accounts.google.com/v3/signin') ||
          url.includes('accounts.google.com/AccountChooser')

      if (!isSignInPage) {
        const pageContent = await this.page.evaluate(() => document.body.innerText.substring(0, 2000).toLowerCase())
        const email = config.googleAccountUser.toLowerCase()
        if (pageContent.includes(email)) {
          console.log(`[bot/${this.meetingId.slice(0, 8)}] ✓ Google session active (verified ${email})`)
          return true
        }
      }

      console.log(`[bot/${this.meetingId.slice(0, 8)}] No active Google session — will join as guest`)
      return false
    } catch (err) {
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Session check failed: ${(err as Error).message}`)
      return false
    }
  }

  private async performFreshGoogleSignIn(): Promise<boolean> {
    if (!this.page) return false

    const email = config.googleAccountUser
    const password = config.googleAccountPassword

    if (!email || !password) {
      console.warn(`[bot/${this.meetingId.slice(0, 8)}] No Google credentials configured — joining as guest`)
      return true // Continue without auth
    }

    try {
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Signing into Google as ${email}...`)

      // Navigate to Google sign-in
      await this.page.goto('https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      })
      await this.sleep(2000)

      // Debug: log page state
      const signInUrl = this.page.url()
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Sign-in page URL: ${signInUrl}`)

      // ── Enter email ────────────────────────────────────────────────
      const emailInput = await this.page.waitForSelector('input[type="email"]', { timeout: 10000 })
      if (!emailInput) throw new Error('Email input not found on sign-in page')

      await emailInput.click()
      await this.sleep(300)
      await emailInput.type(email, { delay: 50 })
      await this.sleep(500)

      // Click "Next" button
      const emailNext = await this.page.$('#identifierNext')
      if (emailNext) {
        await emailNext.click()
      } else {
        // Fallback: find button with "Next" text
        await this.page.evaluate(() => {
          const buttons = document.querySelectorAll('button, [role="button"]')
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toLowerCase() || ''
            if (text === 'next' || text === 'suivant' || text === 'weiter') {
              (btn as HTMLElement).click()
              return
            }
          }
        })
      }

      console.log(`[bot/${this.meetingId.slice(0, 8)}] Email entered, waiting for password field...`)
      await this.sleep(3000)

      // ── Enter password ─────────────────────────────────────────────
      // Wait for the password input to become visible (Google transitions between pages)
      let passwordInput = null
      for (let i = 0; i < 10; i++) {
        passwordInput = await this.page.$('input[type="password"]:not([aria-hidden="true"])')
        if (passwordInput) {
          // Check if it's actually visible
          const isVisible = await passwordInput.evaluate((el: Element) => {
            const style = window.getComputedStyle(el)
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
          })
          if (isVisible) break
          passwordInput = null
        }
        await this.sleep(1000)
      }

      if (!passwordInput) {
        // Debug: check what's on the page
        const pageText = await this.page.evaluate(() => document.body.innerText.substring(0, 500))
        console.error(`[bot/${this.meetingId.slice(0, 8)}] Password input not found. Page text: ${pageText.replace(/\n/g, ' | ').substring(0, 300)}`)

        // Take debug screenshot
        const screenshotPath = join(config.recordingDir, `${this.meetingId}_auth_debug.png`)
        await this.page.screenshot({ path: screenshotPath, fullPage: true })
        console.error(`[bot/${this.meetingId.slice(0, 8)}] Auth debug screenshot: ${screenshotPath}`)
        throw new Error('Password input not found after entering email')
      }

      await passwordInput.click()
      await this.sleep(300)
      await passwordInput.type(password, { delay: 50 })
      await this.sleep(500)

      // Click "Next" button for password
      const passNext = await this.page.$('#passwordNext')
      if (passNext) {
        await passNext.click()
      } else {
        await this.page.evaluate(() => {
          const buttons = document.querySelectorAll('button, [role="button"]')
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toLowerCase() || ''
            if (text === 'next' || text === 'suivant' || text === 'weiter') {
              (btn as HTMLElement).click()
              return
            }
          }
        })
      }

      console.log(`[bot/${this.meetingId.slice(0, 8)}] Password entered, waiting for sign-in to complete...`)
      await this.sleep(5000)

      // ── Handle post-login screens ──────────────────────────────────
      // Google may show: "Verify it's you", recovery phone, "I agree" TOS, etc.
      const currentUrl = this.page.url()
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Post-login URL: ${currentUrl}`)

      // Handle "I agree" / Terms of Service
      try {
        const agreeBtn = await this.page.evaluate(() => {
          const buttons = document.querySelectorAll('button, [role="button"]')
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toLowerCase() || ''
            if (text === 'i agree' || text === 'agree' || text === 'accept') {
              (btn as HTMLElement).click()
              return true
            }
          }
          return false
        })
        if (agreeBtn) {
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Accepted Google TOS`)
          await this.sleep(3000)
        }
      } catch { /* no TOS screen */ }

      // Handle "Not now" for recovery options, 2FA prompts, etc.
      try {
        for (let i = 0; i < 3; i++) {
          const dismissed = await this.page.evaluate(() => {
            const links = document.querySelectorAll('button, a, [role="button"], [role="link"]')
            for (const el of links) {
              const text = el.textContent?.trim().toLowerCase() || ''
              if (text === 'not now' || text === 'skip' || text === 'no thanks' ||
                  text === 'remind me later' || text === 'done' || text === 'confirm') {
                (el as HTMLElement).click()
                return text
              }
            }
            return null
          })
          if (dismissed) {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Dismissed post-login prompt: "${dismissed}"`)
            await this.sleep(2000)
          } else {
            break
          }
        }
      } catch { /* no prompts */ }

      // ── Verify sign-in succeeded ───────────────────────────────────
      const finalUrl = this.page.url()
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Final URL after sign-in: ${finalUrl}`)

      // Check for challenge/verification pages (2FA, CAPTCHA, etc.)
      if (finalUrl.includes('challenge') || finalUrl.includes('signin/rejected') ||
          finalUrl.includes('deniedsigninrejected')) {
        const pageText = await this.page.evaluate(() => document.body.innerText.substring(0, 500))
        console.error(`[bot/${this.meetingId.slice(0, 8)}] Google is requesting verification: ${pageText.replace(/\n/g, ' | ').substring(0, 300)}`)

        const screenshotPath = join(config.recordingDir, `${this.meetingId}_auth_challenge.png`)
        await this.page.screenshot({ path: screenshotPath, fullPage: true })
        console.error(`[bot/${this.meetingId.slice(0, 8)}] Challenge screenshot: ${screenshotPath}`)
        return false
      }

      // ── Verify sign-in completed ──────────────────────────────────
      // With userDataDir, Chrome automatically persists the session — no manual cookie saving needed
      console.log(`[bot/${this.meetingId.slice(0, 8)}] ✓ Google sign-in successful! Session persisted in Chrome profile`)

      return true
    } catch (err) {
      console.error(`[bot/${this.meetingId.slice(0, 8)}] Google sign-in failed:`, (err as Error).message)

      // Take debug screenshot
      try {
        const screenshotPath = join(config.recordingDir, `${this.meetingId}_auth_debug.png`)
        await this.page.screenshot({ path: screenshotPath, fullPage: true })
        console.error(`[bot/${this.meetingId.slice(0, 8)}] Auth debug screenshot: ${screenshotPath}`)
      } catch { /* screenshot failed */ }

      return false
    }
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
      // ── Step 0: Check if we have an existing Google session ────────────
      // Strategy: Only USE an existing session. Never attempt fresh sign-in
      // (fresh sign-in triggers CAPTCHA). Join as guest if no session exists.
      if (config.googleAccountUser && config.googleAccountPassword) {
        const signedIn = await this.signInToGoogle()
        if (signedIn) {
          console.log(`[bot/${this.meetingId.slice(0, 8)}] ✓ Using authenticated Google session`)
        } else {
          console.log(`[bot/${this.meetingId.slice(0, 8)}] No active session — joining as guest (avoids CAPTCHA)`)
        }
      }

      // Navigate to the Meet URL
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Navigating to: ${this.meetingUrl}`)
      await this.page.goto(this.meetingUrl, { waitUntil: 'networkidle2', timeout: 30000 })
      await this.sleep(3000)

      // Debug: log current URL and page title
      const currentUrl = this.page.url()
      const pageTitle = await this.page.title()
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Page loaded — URL: ${currentUrl}, Title: ${pageTitle}`)

      // ── Step 1: Handle cookie consent / privacy dialogs ─────────────────
      try {
        for (const sel of [
          'button[aria-label*="Accept all" i]',
          'button[aria-label*="Reject all" i]',
          '[aria-label*="Reject all" i]',
          'button[id*="accept"]',
          'form[action*="consent"] button',
        ]) {
          const consentBtn = await this.page.$(sel)
          if (consentBtn) {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Dismissing consent dialog: ${sel}`)
            await consentBtn.click()
            await this.sleep(2000)
            break
          }
        }
        for (const btn of await this.page.$$('button')) {
          const text = await btn.evaluate((el: Element) => el.textContent?.trim().toLowerCase() || '')
          if (text === 'accept all' || text === 'reject all' || text === 'i agree' ||
              text === 'continue' || text === 'accept & continue') {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Dismissing consent: "${text}"`)
            await btn.click()
            await this.sleep(2000)
            break
          }
        }
      } catch { /* no consent dialogs */ }

      await this.sleep(2000)

      // Debug: log what we see on the page
      const pageText = await this.page.evaluate(() => document.body.innerText.substring(0, 800))
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Page text: ${pageText.replace(/\n/g, ' | ').substring(0, 500)}`)

      // ── Step 2: Handle "Do you want people to see and hear you?" screen ──
      // Google Meet shows this for unauthenticated users BEFORE the pre-join lobby
      try {
        // Option A: Click "Continue without microphone and camera"
        const continueWithoutLink = await this.page.evaluate(() => {
          const links = document.querySelectorAll('a, button, [role="link"], [role="button"]')
          for (const el of links) {
            const text = el.textContent?.trim().toLowerCase() || ''
            if (text.includes('continue without microphone') || text.includes('without microphone and camera')) {
              (el as HTMLElement).click()
              return true
            }
          }
          return false
        })

        if (continueWithoutLink) {
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Clicked "Continue without microphone and camera"`)
          await this.sleep(3000)
        } else {
          // Option B: Click "Use microphone and camera" button
          const useMicBtn = await this.page.evaluate(() => {
            const btns = document.querySelectorAll('button, [role="button"]')
            for (const btn of btns) {
              const text = btn.textContent?.trim().toLowerCase() || ''
              if (text.includes('use microphone and camera')) {
                (btn as HTMLElement).click()
                return true
              }
            }
            return false
          })
          if (useMicBtn) {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Clicked "Use microphone and camera"`)
            await this.sleep(3000)
          }
        }
      } catch { /* not on this screen */ }

      // ── Step 3: Dismiss "Got it" / info popups ─────────────────────────
      try {
        for (const btn of await this.page.$$('button')) {
          const text = await btn.evaluate((el: Element) => el.textContent?.trim().toLowerCase())
          if (text === 'got it' || text === 'dismiss' || text === 'close' || text === 'ok') {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Dismissed: "${text}"`)
            await btn.click()
            await this.sleep(500)
          }
        }
      } catch { /* no dialogs */ }

      // Debug: log page state after pre-screens
      const pageText2 = await this.page.evaluate(() => document.body.innerText.substring(0, 500))
      console.log(`[bot/${this.meetingId.slice(0, 8)}] After pre-screens: ${pageText2.replace(/\n/g, ' | ').substring(0, 400)}`)

      // ── Step 4: Turn off camera + mic if on the pre-join lobby ──────────
      const camToggled = await this.clickWithFallback(
        ['[data-is-muted][aria-label*="camera" i]', '[aria-label*="Turn off camera" i]', '[data-tooltip*="camera" i]'],
        'the camera toggle button to turn off the camera on the Google Meet pre-join screen',
      )
      if (camToggled) console.log(`[bot/${this.meetingId.slice(0, 8)}] Camera toggled off`)
      await this.sleep(500)

      const micToggled = await this.clickWithFallback(
        ['[data-is-muted][aria-label*="microphone" i]', '[aria-label*="Turn off microphone" i]', '[data-tooltip*="microphone" i]'],
        'the microphone toggle button to mute the microphone on the Google Meet pre-join screen',
      )
      if (micToggled) console.log(`[bot/${this.meetingId.slice(0, 8)}] Microphone toggled off`)
      await this.sleep(500)

      // ── Step 5: Enter name if prompted ─────────────────────────────────
      try {
        const nameInput = await this.page.$('input[aria-label*="name" i]')
          || await this.page.$('input[placeholder*="name" i]')
          || await this.page.$('input[aria-label*="Your name" i]')
          || await this.page.$('input[type="text"]')
        if (nameInput) {
          await nameInput.click({ clickCount: 3 })
          await nameInput.type('Zerowing (Meeting Bot)')
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Entered bot name`)
          await this.sleep(500)
        }
      } catch { /* no name prompt */ }

      // Click join button — uses clickWithFallback: CSS selectors → text → DomAgent LLM
      const joinSelectors = [
        'button[data-idom-class*="join"]',
        '[aria-label*="Join now" i]',
        '[aria-label*="Ask to join" i]',
        '[aria-label*="Join meeting" i]',
        'button[jsname="Qx7uuf"]',  // Known Google Meet join button jsname
      ]
      const joinTextPatterns = ['join now', 'ask to join', 'join meeting', 'join']
      const joined = await this.clickWithFallback(
        joinSelectors,
        'the Join Now or Ask to Join button on the Google Meet pre-join screen',
        joinTextPatterns,
      )

      if (!joined) {
        // Debug: take a screenshot and dump button info
        try {
          const screenshotPath = join(config.recordingDir, `${this.meetingId}_debug.png`)
          await this.page.screenshot({ path: screenshotPath, fullPage: true })
          console.error(`[bot/${this.meetingId.slice(0, 8)}] Debug screenshot saved: ${screenshotPath}`)

          const allButtons = await this.page.evaluate(() => {
            const btns = document.querySelectorAll('button, [role="button"]')
            return Array.from(btns).map(b => ({
              text: b.textContent?.trim().substring(0, 80),
              ariaLabel: b.getAttribute('aria-label'),
              id: b.id,
              className: b.className?.toString().substring(0, 60),
            }))
          })
          console.error(`[bot/${this.meetingId.slice(0, 8)}] All buttons on page:`, JSON.stringify(allButtons, null, 2))
        } catch { /* debug failed */ }

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
            // After 10s with no "waiting" text, check for actual in-call indicators
            // Don't just assume — verify we're actually in the meeting
            const inCall = await this.page.evaluate(() => {
              // Look for definitive in-call UI elements
              const endCall = document.querySelector('[aria-label*="Leave call" i], [aria-label*="End call" i], [data-tooltip*="Leave call" i]')
              const participant = document.querySelector('[data-participant-id]')
              const meetingToolbar = document.querySelector('[aria-label*="meeting" i][role="toolbar"], [jsname="A5il2e"]')
              return !!(endCall || participant || meetingToolbar)
            })
            if (inCall) {
              admitted = true
              console.log(`[bot/${this.meetingId.slice(0, 8)}] Appears to have joined directly (no admission gate detected)`)
              break
            }
            // Not in call yet — keep waiting (might be a slow join or host hasn't started)
            if (waited % 15_000 < admissionPoll) {
              console.log(`[bot/${this.meetingId.slice(0, 8)}] Not yet in meeting — no waiting text but no in-call UI either (${waited / 1000}s)`)
            }
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

  // ─── Participant Name Scraping (DOM) ─────────────────────────────────

  private participantsSscraped = false

  private async scrapeParticipantNames(): Promise<void> {
    if (!this.page || this.participantsSscraped) return

    try {
      const names: string[] = await this.page.evaluate(() => {
        const found: string[] = []

        // Method 1: data-self-name attributes on participant tiles
        const selfNameEls = document.querySelectorAll('[data-self-name]')
        for (const el of selfNameEls) {
          const name = el.getAttribute('data-self-name')?.trim()
          if (name) found.push(name)
        }

        // Method 2: Participant tiles with name labels
        // Google Meet renders name labels inside video tiles
        const nameClasses = ['ZjFb7c', 'cS7aqe', 'zWGUib', 'XEazBc']
        for (const cls of nameClasses) {
          const els = document.querySelectorAll(`[class*="${cls}"]`)
          for (const el of els) {
            const name = el.textContent?.trim()
            if (name && name.length > 0 && name.length < 60) found.push(name)
          }
        }

        // Method 3: aria-label on participant tiles often has "Name, muted" etc.
        const tiles = document.querySelectorAll('[data-participant-id]')
        for (const tile of tiles) {
          const ariaLabel = tile.getAttribute('aria-label') || ''
          // Extract name from patterns like "Muhammad Ali, microphone on" or just "Muhammad Ali"
          const nameMatch = ariaLabel.match(/^([^,]+)/)
          if (nameMatch && nameMatch[1].trim().length > 1) {
            found.push(nameMatch[1].trim())
          }
        }

        return found
      })

      // Fix doubled names from textContent (e.g., "Ali SAli S" → "Ali S")
      const dedup = (name: string): string => {
        if (name.length >= 4 && name.length % 2 === 0) {
          const half = name.length / 2
          if (name.slice(0, half) === name.slice(half)) return name.slice(0, half)
        }
        // Also catch odd-length near-duplicates like "Ali S Ali S" with space join
        const mid = Math.floor(name.length / 2)
        for (let i = mid - 1; i <= mid + 1; i++) {
          if (i > 0 && i < name.length) {
            const a = name.slice(0, i).trim()
            const b = name.slice(i).trim()
            if (a && b && a === b) return a
          }
        }
        return name
      }

      // Filter out bot names and duplicates
      const botNames = new Set(['zerowing', 'zerowing (meeting bot)', 'captain', 'meeting bot', 'bot', 'you'])
      const uniqueNames = [...new Set(
        names.map(n => dedup(n.trim())).filter(n => n && !botNames.has(n.toLowerCase()))
      )]

      if (uniqueNames.length > 0) {
        for (const name of uniqueNames) {
          this.participants.add(name)
        }
        this.participantsSscraped = true
        console.log(`[bot/${this.meetingId.slice(0, 8)}] Scraped participant names: ${uniqueNames.join(', ')}`)

        // Update meeting record with participant names
        await this.updateMeetingParticipants(uniqueNames)
      }
    } catch {
      // Best-effort, don't crash the bot
    }
  }

  private async updateMeetingParticipants(names: string[]): Promise<void> {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey)

      const participants = names.map(name => ({ name, email: '' }))

      await supabase
        .from('meetings')
        .update({ participants })
        .eq('id', this.meetingId)
    } catch (err) {
      console.error(`[bot/${this.meetingId.slice(0, 8)}] Failed to update participants:`, (err as Error).message)
    }
  }

  // ─── Helper: Bot Name Check ────────────────────────────────────────────

  private isBotName(name: string): boolean {
    const lower = name.toLowerCase()
    return lower === 'zerowing' || lower === 'zerowing (meeting bot)' ||
           lower === 'captain' || lower === 'captain (meeting bot)' ||
           lower === 'meeting bot' || lower === 'bot' || lower === 'you'
  }

  // ─── Helper: Add Speaker Event ────────────────────────────────────────

  private addSpeakerEvent(speaker: string, elapsed: number): void {
    if (this.speakerTimeline.length > 0) {
      this.speakerTimeline[this.speakerTimeline.length - 1].endTime = elapsed
    }
    this.speakerTimeline.push({ speaker, startTime: elapsed, endTime: elapsed })
    this.currentSpeaker = speaker
  }

  // ─── Click With Fallback (CSS → Text → DomAgent LLM) ─────────────────

  /**
   * Try to click an element using hardcoded selectors first,
   * then fall back to asking the DomAgent LLM if all selectors fail.
   */
  private async clickWithFallback(
    selectors: string[],
    description: string,
    textPatterns?: string[],
  ): Promise<boolean> {
    if (!this.page) return false

    // Strategy 1: Try each hardcoded CSS selector
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel)
        if (el) {
          const isVisible = await el.evaluate((e: Element) => {
            const rect = e.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
          if (isVisible) {
            await el.click()
            return true
          }
        }
      } catch { /* try next */ }
    }

    // Strategy 2: Text-based search on buttons
    if (textPatterns && textPatterns.length > 0) {
      try {
        for (const btn of await this.page.$$('button, [role="button"]')) {
          const text = await btn.evaluate((el: Element) => el.textContent?.trim().toLowerCase() || '')
          for (const pattern of textPatterns) {
            if (text === pattern || text.includes(pattern)) {
              await btn.click()
              return true
            }
          }
        }
      } catch { /* try next strategy */ }
    }

    // Strategy 3: DomAgent agentic loop — find and click
    if (this.domAgent) {
      console.log(`[bot/${this.meetingId.slice(0, 8)}] Selectors failed for "${description}" — running DomAgent agentic loop...`)
      const clicked = await this.domAgent.findAndClick(description)
      if (clicked) {
        console.log(`[bot/${this.meetingId.slice(0, 8)}] DomAgent agentic loop found and clicked element`)
        return true
      }
    }

    return false
  }

  // ─── Active Speaker Detection (DOM) ────────────────────────────────────

  private async detectActiveSpeaker(): Promise<void> {
    if (!this.page) return

    try {
      let speaker: string | null = null
      const isGoogleMeet = this.platform === 'google_meet' || this.meetingUrl.includes('meet.google.com')

      // Tier 1: Try DOM-based detection with DISCOVERED patterns (from DomAgent analysis)
      if (!speaker && this.discoveredPatterns) {
        speaker = await this.detectWithDiscoveredPatterns()
      }

      // Tier 2: Try DOM-based detection with HARDCODED patterns (existing selectors)
      if (!speaker) {
        speaker = isGoogleMeet
          ? await this.detectGoogleMeetSpeaker()
          : await this.detectZoomSpeaker()
      }

      // Tier 3: Try caption-based detection (data-sender-name — most reliable if captions on)
      if (!speaker) {
        speaker = await this.getLatestCaptionSpeaker()
      }

      if (speaker && !this.isBotName(speaker)) {
        this.participants.add(speaker)
        this.consecutiveNulls = 0 // Reset failure counter

        if (speaker !== this.currentSpeaker) {
          const elapsed = (Date.now() - this.startTime) / 1000
          this.addSpeakerEvent(speaker, elapsed)
        }
      } else {
        this.consecutiveNulls++
      }
    } catch {
      // Best-effort, don't crash the bot
      this.consecutiveNulls++
    }
  }

  /**
   * Detect speaker using patterns discovered by DomAgent LLM analysis.
   */
  private async detectWithDiscoveredPatterns(): Promise<string | null> {
    if (!this.discoveredPatterns || !this.page) return null

    try {
      return await this.page.evaluate((patterns: SpeakerPatterns) => {
        // Try the discovered active speaker selector
        const speakingEl = document.querySelector(patterns.activeSpeakerSelector)
        if (!speakingEl) return null

        // Extract name using discovered method
        const tile = speakingEl.closest(patterns.tileSelector) || speakingEl

        // Try data attribute extraction
        if (patterns.nameExtraction.startsWith('data-')) {
          const name = tile.getAttribute(patterns.nameExtraction)
          if (name) return name.trim()
        }

        // Try aria-label extraction (name before first comma)
        if (patterns.nameExtraction === 'aria-label') {
          const label = tile.getAttribute('aria-label') || ''
          const match = label.match(/^([^,]+)/)
          if (match && match[1].trim().length > 1) return match[1].trim()
        }

        // Try it as a CSS selector for a name element
        try {
          const nameEl = tile.querySelector(patterns.nameExtraction)
          if (nameEl?.textContent) return nameEl.textContent.trim()
        } catch { /* not a valid selector */ }

        // Fallback: look for data-self-name within the tile
        const selfName = tile.querySelector('[data-self-name]')?.getAttribute('data-self-name')
        if (selfName) return selfName.trim()

        return null
      }, this.discoveredPatterns)
    } catch {
      return null
    }
  }

  /**
   * Get the most recent speaker from live captions (data-sender-name).
   * Works even if captionsEnabled is false — captions might be on externally.
   */
  private async getLatestCaptionSpeaker(): Promise<string | null> {
    if (!this.page) return null

    try {
      return await this.page.evaluate(() => {
        const senderEls = document.querySelectorAll('[data-sender-name]')
        if (senderEls.length === 0) return null
        // Return the last (most recent) caption speaker
        const lastEl = senderEls[senderEls.length - 1]
        return lastEl.getAttribute('data-sender-name') || null
      })
    } catch {
      return null
    }
  }

  private async detectGoogleMeetSpeaker(): Promise<string | null> {
    if (!this.page) return null

    return this.page.evaluate(() => {
      // Google Meet active speaker detection — updated March 2026 from live DOM analysis
      //
      // Meet adds these CSS classes to the active speaker's tile:
      //   .Zi94Db.S7urwe  → blue border wrapper (most reliable)
      //   .CNjCjf.kssMZb  → video container indicator
      //   .lH9pqf.kssMZb  → bottom bar indicator
      //
      // Participant name lives in: tile.querySelector('.notranslate')
      // Tile wrapper: div.oZRSLe[data-participant-id]

      // ── Method 1 (primary): S7urwe class = blue speaking border ──
      const speakingBorder = document.querySelector('.Zi94Db.S7urwe')
      if (speakingBorder) {
        const tile = speakingBorder.closest('[data-participant-id]')
        if (tile) {
          // Extract name from the tile's name display area
          const nameEl = tile.querySelector('.XEazBc .notranslate')
            || tile.querySelector('.notranslate')
          if (nameEl?.textContent?.trim()) return nameEl.textContent.trim()
          // Fallback: extract from aria-label "Pin X to your main screen"
          const pinBtn = tile.querySelector('[aria-label^="Pin "]')
          if (pinBtn) {
            const match = pinBtn.getAttribute('aria-label')?.match(/^Pin (.+?) to/)
            if (match) return match[1]
          }
        }
      }

      // ── Method 2: kssMZb on video container ──
      const speakingVC = document.querySelector('.CNjCjf.kssMZb')
      if (speakingVC) {
        const tile = speakingVC.closest('[data-participant-id]')
        if (tile) {
          const nameEl = tile.querySelector('.XEazBc .notranslate')
            || tile.querySelector('.notranslate')
          if (nameEl?.textContent?.trim()) return nameEl.textContent.trim()
        }
      }

      // ── Method 3: Scan all tiles for active border class ──
      const tiles = document.querySelectorAll('[data-participant-id]')
      for (const tile of tiles) {
        // Check for S7urwe (speaking border) or kssMZb (speaking marker)
        if (tile.querySelector('.S7urwe') || tile.querySelector('.kssMZb')) {
          const nameEl = tile.querySelector('.XEazBc .notranslate')
            || tile.querySelector('.notranslate')
          if (nameEl?.textContent?.trim()) return nameEl.textContent.trim()
          // Try aria-label extraction
          const muteBtn = tile.querySelector('[aria-label*="Mute"][aria-label*="microphone"]')
          if (muteBtn) {
            const match = muteBtn.getAttribute('aria-label')?.match(/Mute (.+?)'s microphone/)
            if (match) return match[1]
          }
        }
      }

      // ── Method 4: Legacy fallbacks ──
      // data-is-speaking (older Meet versions)
      const legacySpeaking = document.querySelector('[data-is-speaking="true"]')
      if (legacySpeaking) {
        const tile = legacySpeaking.closest('[data-participant-id]') || legacySpeaking
        const nameEl = tile.querySelector('.notranslate')
          || tile.querySelector('[data-self-name]')
        if (nameEl) return nameEl.textContent?.trim() || nameEl.getAttribute('data-self-name') || null
      }

      // Caption speaker name (if captions are enabled)
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
      const captionSelectors = isGoogleMeet
        ? ['[aria-label*="captions" i]', '[aria-label*="subtitles" i]', '[data-tooltip*="captions" i]']
        : ['[aria-label*="live transcript" i]', '[aria-label*="closed caption" i]', '[aria-label*="captions" i]']

      // Method 1: Try hardcoded selectors
      for (const sel of captionSelectors) {
        const btn = await this.page.$(sel)
        if (btn) {
          await btn.click()
          await this.sleep(1500)
          this.captionsEnabled = true
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Captions enabled via selector`)
          return
        }
      }

      // Method 2: Keyboard shortcut (Google Meet: 'c' toggles captions)
      if (isGoogleMeet) {
        await this.page.keyboard.press('c')
        await this.sleep(2000)
        // Verify captions appeared
        const hasCaptions = await this.page.$('[data-sender-name]')
        if (hasCaptions) {
          this.captionsEnabled = true
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Captions enabled via keyboard shortcut 'c'`)
          return
        }
      }

      // Method 3: Ask DomAgent to find the captions button
      if (!this.captionsEnabled) {
        const clicked = await this.clickWithFallback(
          captionSelectors,
          isGoogleMeet
            ? 'the closed captions or subtitles toggle button in the bottom toolbar of Google Meet'
            : 'the closed captions or live transcript toggle button in the Zoom toolbar',
        )
        if (clicked) {
          await this.sleep(1500)
          const hasCaptions = await this.page.$('[data-sender-name]')
          if (hasCaptions) {
            this.captionsEnabled = true
            console.log(`[bot/${this.meetingId.slice(0, 8)}] Captions enabled via DomAgent`)
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
    // Always try scraping — captions might be enabled externally or by other participants
    if (!this.page) return

    try {
      const captions = await this.page.evaluate(() => {
        const results: { speaker: string; text: string }[] = []

        // Google Meet captions — primary source with speaker names
        const senderEls = document.querySelectorAll('[data-sender-name]')
        for (const el of senderEls) {
          const speaker = el.getAttribute('data-sender-name') || 'Unknown'
          const text = el.textContent?.trim() || ''
          if (text) results.push({ speaker, text })
        }

        // Generic caption containers (no speaker names)
        if (results.length === 0) {
          const containers = document.querySelectorAll('[class*="caption"], [class*="subtitle"]')
          for (const c of containers) {
            const text = c.textContent?.trim() || ''
            if (text.length > 2) results.push({ speaker: 'Unknown', text })
          }
        }

        return results
      })

      if (captions.length === 0) return

      // If we see captions but haven't flagged them as enabled, do so now
      if (!this.captionsEnabled) {
        this.captionsEnabled = true
        console.log(`[bot/${this.meetingId.slice(0, 8)}] Captions detected (externally enabled)`)
      }

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

        // ALSO feed caption speaker into the speaker timeline
        // Captions have verified speaker names from Google — most reliable source
        if (cap.speaker && cap.speaker !== 'Unknown' && !this.isBotName(cap.speaker)) {
          this.participants.add(cap.speaker)
          if (cap.speaker !== this.currentSpeaker) {
            this.addSpeakerEvent(cap.speaker, elapsed)
          }
        }
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
    let domAnalysisScheduled = false

    while (!this.shouldStop && elapsed < MAX_DURATION_MS) {
      await this.sleep(POLL_MS)
      elapsed += POLL_MS

      // Detect active speaker from DOM (3-tier cascade: discovered → hardcoded → captions)
      await this.detectActiveSpeaker()

      // Scrape captions (always try — also feeds speaker names into timeline)
      await this.scrapeCaptions()

      // Check for meeting end every 15s
      if (elapsed - lastEndCheck >= END_CHECK_MS) {
        lastEndCheck = elapsed
        if (await this.isMeetingEnded()) {
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Meeting ended`)
          return
        }
      }

      // Re-scrape participant names every 30s (in case new people join)
      if (elapsed % 30000 < POLL_MS) {
        this.participantsSscraped = false  // Allow re-scraping
        await this.scrapeParticipantNames()
      }

      // ── DOM Agent: Proactive speaker pattern discovery ──
      // After ~20s in meeting and participants detected, run DOM analysis once
      if (
        !domAnalysisScheduled &&
        elapsed > 20000 &&
        this.participants.size > 0 &&
        this.domAgent &&
        !this.discoveredPatterns
      ) {
        domAnalysisScheduled = true
        console.log(`[bot/${this.meetingId.slice(0, 8)}] Running proactive DOM analysis for speaker detection...`)
        try {
          this.discoveredPatterns = await this.domAgent.discoverSpeakerPatterns()
          if (this.discoveredPatterns) {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] ✓ DOM Agent discovered speaker patterns: tile="${this.discoveredPatterns.tileSelector}", speaker="${this.discoveredPatterns.activeSpeakerSelector}", name="${this.discoveredPatterns.nameExtraction}"`)
          } else {
            console.log(`[bot/${this.meetingId.slice(0, 8)}] DOM Agent could not discover speaker patterns — using hardcoded fallbacks`)
          }
        } catch (err) {
          console.warn(`[bot/${this.meetingId.slice(0, 8)}] DOM analysis error:`, (err as Error).message)
        }
      }

      // ── DOM Agent: Re-analyze if detection is consistently failing ──
      // If 30+ consecutive nulls (60s of failure), try re-discovering patterns
      if (
        this.consecutiveNulls >= 30 &&
        !this.domAnalysisInProgress &&
        this.domAgent &&
        elapsed > 60000 // Don't re-analyze in the first minute
      ) {
        this.domAnalysisInProgress = true
        console.log(`[bot/${this.meetingId.slice(0, 8)}] Speaker detection failing for 60s — re-running DOM analysis...`)
        try {
          const newPatterns = await this.domAgent.discoverSpeakerPatterns()
          if (newPatterns) {
            this.discoveredPatterns = newPatterns
            console.log(`[bot/${this.meetingId.slice(0, 8)}] ✓ Re-discovered speaker patterns`)
          }
        } catch { /* best-effort */ }
        this.domAnalysisInProgress = false
        this.consecutiveNulls = 0  // Reset counter regardless
      }

      // ── DOM Agent: Fallback participant scraping ──
      // If participant scraping returned nothing after 30s, try DomAgent
      if (
        elapsed > 30000 &&
        this.participants.size === 0 &&
        this.domAgent &&
        elapsed % 60000 < POLL_MS  // Try once per minute
      ) {
        try {
          const names = await this.domAgent.findParticipantNames()
          if (names.length > 0) {
            for (const name of names) {
              if (!this.isBotName(name)) this.participants.add(name)
            }
            console.log(`[bot/${this.meetingId.slice(0, 8)}] DomAgent found participants: ${names.join(', ')}`)
            await this.updateMeetingParticipants(names.filter(n => !this.isBotName(n)))
          }
        } catch { /* best-effort */ }
      }

      // Log progress every 5 min
      if (elapsed % (5 * 60 * 1000) < POLL_MS) {
        const mins = Math.round(elapsed / 60000)
        const domAgentCalls = this.domAgent?.calls ?? 0
        console.log(`[bot/${this.meetingId.slice(0, 8)}] Recording... ${mins}min, ${this.speakerTimeline.length} speaker events, ${this.participants.size} participants, ${domAgentCalls} DomAgent calls`)
      }
    }

    if (elapsed >= MAX_DURATION_MS) {
      console.warn(`[bot/${this.meetingId.slice(0, 8)}] Max duration (4h) reached.`)
    }
  }

  private async isMeetingEnded(): Promise<boolean> {
    if (!this.page) return true
    try {
      const result = await this.page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase()

        // Check for explicit end-of-meeting text
        const endPhrases = [
          'you left the meeting', "you've left the meeting", 'the meeting has ended',
          'the call has ended', 'return to home screen', 'removed from the meeting', 'meeting ended',
        ]
        for (const phrase of endPhrases) {
          if (bodyText.includes(phrase)) return { ended: true, reason: phrase }
        }

        // Check participant count — Google Meet shows participant count in various ways
        // Method 1: Check the people panel button which shows a badge count
        const participantBadge = document.querySelector('[data-participant-count]')
        if (participantBadge) {
          const count = parseInt(participantBadge.getAttribute('data-participant-count') || '0', 10)
          return { ended: false, participantCount: count }
        }

        // Method 2: Look for "You're the only one here" text
        if (bodyText.includes("you're the only one here") || bodyText.includes('no one else is here')) {
          return { ended: false, participantCount: 1, alone: true }
        }

        // Method 3: Check the participant list count from the people button aria-label
        // Google Meet's people button often has aria-label like "1 participant" or "Show everyone (1)"
        const peopleBtn = document.querySelector('[aria-label*="participant" i]')
          || document.querySelector('[aria-label*="people" i]')
          || document.querySelector('[data-tooltip*="participant" i]')
        if (peopleBtn) {
          const label = peopleBtn.getAttribute('aria-label') || peopleBtn.getAttribute('data-tooltip') || ''
          const match = label.match(/(\d+)/)
          if (match) {
            return { ended: false, participantCount: parseInt(match[1], 10) }
          }
        }

        // Method 4: Count visible participant tiles (each has a data-participant-id)
        const tiles = document.querySelectorAll('[data-participant-id]')
        if (tiles.length > 0) {
          return { ended: false, participantCount: tiles.length }
        }

        return { ended: false, participantCount: -1 } // Unknown
      })

      if (result.ended) {
        console.log(`[bot/${this.meetingId.slice(0, 8)}] Meeting end detected: "${result.reason}"`)
        return true
      }

      // Alone-in-meeting detection
      const ALONE_TIMEOUT_MS = 60_000        // 60s alone after others were seen → leave
      const ALONE_SINCE_JOIN_MS = 180_000    // 3min alone since join (nobody ever seen) → leave
      const isAlone = result.participantCount === 1 || (result as any).alone === true

      if (isAlone) {
        if (this.aloneStartTime === 0) {
          this.aloneStartTime = Date.now()
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Bot is alone in meeting — starting countdown`)
        }

        const aloneFor = Date.now() - this.aloneStartTime

        if (this.wasEverNotAlone && aloneFor >= ALONE_TIMEOUT_MS) {
          // Everyone left after meeting started
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Bot has been alone for ${ALONE_TIMEOUT_MS / 1000}s — all participants left, ending recording`)
          return true
        } else if (!this.wasEverNotAlone && aloneFor >= ALONE_SINCE_JOIN_MS) {
          // Nobody ever joined — meeting is over or empty
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Bot has been alone for ${ALONE_SINCE_JOIN_MS / 1000}s since join — no participants ever detected, leaving meeting`)
          return true
        }
      } else if (!isAlone && (result.participantCount ?? 0) > 1) {
        // Others are present
        if (!this.wasEverNotAlone) {
          this.wasEverNotAlone = true
          console.log(`[bot/${this.meetingId.slice(0, 8)}] Detected ${result.participantCount} participants in meeting`)

          // Scrape participant names on first detection of other participants
          await this.scrapeParticipantNames()
        }
        this.aloneStartTime = 0 // Reset alone timer
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
