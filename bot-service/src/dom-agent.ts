/**
 * DomAgent — LLM-Powered DOM Understanding
 *
 * Instead of hardcoding CSS selectors that break when Google changes their DOM,
 * we ask an LLM to analyze the live DOM structure and discover the right patterns.
 *
 * Called sparingly — only when:
 *  1. Hardcoded selectors fail (fallback for clicking buttons)
 *  2. First time discovering speaker detection patterns (after joining)
 *  3. If discovered patterns stop working mid-session
 *
 * Uses OpenRouter API with a fast/cheap model (Gemini Flash by default).
 */

import type { Page } from 'puppeteer'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SpeakerPatterns {
  /** CSS selector that matches the currently-speaking participant's tile/element */
  activeSpeakerSelector: string
  /** How to extract the speaker name from the matched element */
  nameExtraction: string // e.g., 'data-self-name', 'aria-label', or a CSS selector
  /** What attribute/style changes when someone speaks */
  changingAttribute: string // e.g., 'data-is-speaking', 'class', 'style.borderColor'
  /** CSS selector for participant tile containers */
  tileSelector: string
}

export interface DomAgentConfig {
  apiKey: string
  model: string
  /** Base URL for OpenRouter (default: https://openrouter.ai/api/v1) */
  baseUrl?: string
}

/* ------------------------------------------------------------------ */
/*  DOM Snapshot Helper                                                */
/* ------------------------------------------------------------------ */

/**
 * Extract a cleaned, compact DOM snapshot from the page.
 * Strips scripts/styles, limits depth, keeps only useful attributes.
 * Result is typically 3-8KB — small enough to send to an LLM.
 */
async function getCleanDomSnapshot(
  page: Page,
  rootSelector?: string,
  maxDepth = 5,
): Promise<string> {
  return page.evaluate(
    (root, depth) => {
      const container = root ? document.querySelector(root) : document.body
      if (!container) return ''

      const SKIP_TAGS = new Set([
        'script', 'style', 'svg', 'path', 'noscript', 'link', 'meta', 'head',
      ])

      const KEEP_ATTRS = [
        'id', 'class', 'aria-label', 'role', 'data-self-name',
        'data-participant-id', 'data-requested-participant-id',
        'data-is-speaking', 'data-is-main-screen', 'data-sender-name',
        'data-tooltip', 'aria-pressed', 'jsname', 'jscontroller',
        'type', 'placeholder', 'value', 'disabled', 'aria-disabled',
        'data-idom-class', 'data-panel-id', 'aria-live',
        'data-participant-count', 'tabindex', 'aria-haspopup',
      ]

      function serialize(el: Element, d: number): string {
        if (d > depth) return '...'
        const tag = el.tagName.toLowerCase()
        if (SKIP_TAGS.has(tag)) return ''

        // Collect attributes
        const attrs: string[] = []
        for (const attr of KEEP_ATTRS) {
          const val = el.getAttribute(attr)
          if (val != null && val !== '') {
            attrs.push(`${attr}="${val.slice(0, 100)}"`)
          }
        }

        // For participant tiles, include computed border/outline
        if (
          el.hasAttribute('data-participant-id') ||
          el.hasAttribute('data-requested-participant-id')
        ) {
          try {
            const style = window.getComputedStyle(el)
            const border = style.borderColor
            const outline = style.outlineColor
            if (border && border !== 'rgb(0, 0, 0)') {
              attrs.push(`computed-border="${border}"`)
            }
            if (outline && outline !== 'rgb(0, 0, 0)') {
              attrs.push(`computed-outline="${outline}"`)
            }
          } catch { /* skip */ }
        }

        // Get direct text content (only if this node has a single text child)
        let text = ''
        if (el.childNodes.length <= 2) {
          for (const child of el.childNodes) {
            if (child.nodeType === 3) { // TEXT_NODE
              const t = child.textContent?.trim()
              if (t && t.length > 0 && t.length < 60) {
                text += t
              }
            }
          }
        }

        // Recurse into children
        const children = Array.from(el.children)
          .map(c => serialize(c, d + 1))
          .filter(Boolean)

        const attrStr = attrs.length ? ' ' + attrs.join(' ') : ''
        if (!children.length && !text && !attrStr) return ''

        return `<${tag}${attrStr}>${text}${children.join('')}</${tag}>`
      }

      return serialize(container, 0)
    },
    rootSelector ?? null,
    maxDepth,
  )
}

/**
 * Get a focused snapshot of interactive elements (buttons, links, inputs).
 * Useful for findElement() — smaller and more relevant than full DOM.
 */
async function getInteractiveSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const elements: string[] = []
    const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]'
    const els = document.querySelectorAll(interactiveSelectors)

    for (const el of els) {
      const rect = el.getBoundingClientRect()
      // Skip invisible elements
      if (rect.width === 0 || rect.height === 0) continue

      const tag = el.tagName.toLowerCase()
      const attrs: string[] = []

      for (const attr of ['id', 'class', 'aria-label', 'role', 'data-tooltip',
        'jsname', 'type', 'placeholder', 'aria-pressed', 'data-idom-class',
        'aria-disabled', 'disabled', 'aria-haspopup', 'tabindex']) {
        const val = el.getAttribute(attr)
        if (val != null && val !== '') {
          attrs.push(`${attr}="${val.slice(0, 80)}"`)
        }
      }

      const text = el.textContent?.trim().slice(0, 60) || ''
      const attrStr = attrs.length ? ' ' + attrs.join(' ') : ''
      elements.push(`<${tag}${attrStr}>${text}</${tag}>`)
    }

    return elements.join('\n')
  })
}

/* ------------------------------------------------------------------ */
/*  LLM Calling                                                        */
/* ------------------------------------------------------------------ */

async function callLLM(
  config: DomAgentConfig,
  systemPrompt: string,
  userPrompt: string,
  screenshot?: string, // base64 image
): Promise<string> {
  const baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1'

  const messages: Array<{
    role: string
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  }> = [
    { role: 'system', content: systemPrompt },
  ]

  // If we have a screenshot, send multimodal message
  if (screenshot) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${screenshot}` },
        },
      ],
    })
  } else {
    messages.push({ role: 'user', content: userPrompt })
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0,
      max_tokens: 1024,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenRouter API error (${response.status}): ${text.slice(0, 200)}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content?.trim() || ''
}

/* ------------------------------------------------------------------ */
/*  DomAgent Class                                                     */
/* ------------------------------------------------------------------ */

export class DomAgent {
  private page: Page
  private config: DomAgentConfig
  private callCount = 0

  constructor(page: Page, config: DomAgentConfig) {
    this.page = page
    this.config = config
  }

  /** Total LLM calls made this session */
  get calls(): number {
    return this.callCount
  }

  /* ---------------------------------------------------------------- */
  /*  findElement — Find a clickable element by description            */
  /* ---------------------------------------------------------------- */

  /**
   * Ask the LLM to find a specific UI element on the current page.
   * Returns a CSS selector that matches the element, or null.
   *
   * @param description - Human-readable description like "the Join Now button"
   * @param context - Optional extra context like "Google Meet pre-join screen"
   */
  async findElement(description: string, context?: string): Promise<string | null> {
    try {
      // Get compact interactive elements snapshot
      const snapshot = await getInteractiveSnapshot(this.page)
      if (!snapshot) return null

      // Optionally take a screenshot for visual context
      let screenshot: string | undefined
      try {
        const buf = await this.page.screenshot({
          encoding: 'base64',
          type: 'jpeg',
          quality: 40,
        }) as string
        screenshot = buf
      } catch { /* screenshot failed, proceed with DOM only */ }

      const systemPrompt = `You are a DOM analysis agent. Given a list of interactive HTML elements from a web page, find the element that best matches the user's description. Return ONLY a valid CSS selector string that uniquely identifies the element. Do not include any explanation, markdown, or extra text. If you cannot find a matching element, return the word "null".

Rules:
- The selector must work with document.querySelector()
- Prefer selectors using aria-label, jsname, data-* attributes, or id (stable identifiers)
- Avoid selectors that rely only on class names (they change frequently)
- If multiple elements match, return the most specific selector`

      const userPrompt = `${context ? `Context: ${context}\n\n` : ''}Find the element matching: "${description}"

Here are the interactive elements on the page:

${snapshot.slice(0, 8000)}`

      this.callCount++
      const result = await callLLM(this.config, systemPrompt, userPrompt, screenshot)

      // Clean the response — extract just the selector
      const selector = result
        .replace(/^```[a-z]*\n?/g, '')
        .replace(/\n?```$/g, '')
        .replace(/^["'`]|["'`]$/g, '')
        .trim()

      if (!selector || selector === 'null' || selector.length > 200) return null

      // Validate: does this selector actually match an element?
      const exists = await this.page.evaluate((sel) => {
        try {
          const el = document.querySelector(sel)
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        } catch {
          return false
        }
      }, selector)

      return exists ? selector : null
    } catch (err) {
      console.error(`[dom-agent] findElement error:`, (err as Error).message)
      return null
    }
  }

  /* ---------------------------------------------------------------- */
  /*  discoverSpeakerPatterns — Understand speaker detection           */
  /* ---------------------------------------------------------------- */

  /**
   * Analyze the Google Meet DOM to discover how to detect the active speaker.
   * Called once after joining, or when detection stops working.
   */
  async discoverSpeakerPatterns(): Promise<SpeakerPatterns | null> {
    try {
      // Get a DOM snapshot focused on participant tiles
      const snapshot = await getCleanDomSnapshot(this.page, undefined, 5)
      if (!snapshot || snapshot.length < 50) return null

      // Take a screenshot for visual context
      let screenshot: string | undefined
      try {
        const buf = await this.page.screenshot({
          encoding: 'base64',
          type: 'jpeg',
          quality: 50,
        }) as string
        screenshot = buf
      } catch { /* proceed without screenshot */ }

      const systemPrompt = `You are a DOM analysis expert specializing in Google Meet's web interface. Your task is to analyze the DOM structure and identify how to programmatically detect the active speaker in a Google Meet call.

In Google Meet, when someone speaks, their video tile gets a visual indicator — typically a colored border (blue/accent color), a specific data attribute, or a CSS class change. You need to identify these patterns from the provided DOM snapshot.

Return ONLY valid JSON with exactly these fields:
{
  "activeSpeakerSelector": "CSS selector for the element that indicates active speaking (e.g., an attribute or style that only appears on the speaking person's tile)",
  "nameExtraction": "How to get the speaker's name — either a data attribute name like 'data-self-name', 'aria-label' to use the aria-label (split by comma to get name), or a CSS selector to find the name element within the tile",
  "changingAttribute": "The specific attribute or style that changes when someone speaks (e.g., 'data-is-speaking', 'class', 'style.borderColor', 'style.outline')",
  "tileSelector": "CSS selector for individual participant tile containers"
}

If you cannot determine a pattern, return: {"error": "reason"}`

      const userPrompt = `Analyze this Google Meet DOM and identify speaker detection patterns.

Look for:
1. Participant video tiles — containers for each person's video feed
2. Any attributes like data-is-speaking, data-active-speaker, or similar
3. Border/outline styles that differ between tiles (the speaking person usually has a colored border)
4. data-self-name attributes (contain the participant's display name)
5. aria-label attributes on tiles (often contain name + mic/camera status)
6. Any class changes that indicate speaking state

DOM Snapshot:
${snapshot.slice(0, 12000)}`

      this.callCount++
      const result = await callLLM(this.config, systemPrompt, userPrompt, screenshot)

      // Parse the JSON response
      const jsonMatch = result.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.error) {
        console.warn(`[dom-agent] Speaker pattern discovery failed: ${parsed.error}`)
        return null
      }

      // Validate required fields
      if (
        !parsed.activeSpeakerSelector ||
        !parsed.nameExtraction ||
        !parsed.tileSelector
      ) {
        console.warn(`[dom-agent] Incomplete speaker patterns:`, parsed)
        return null
      }

      // Quick validation: does the tile selector match anything?
      const tilesExist = await this.page.evaluate((sel) => {
        try {
          return document.querySelectorAll(sel).length > 0
        } catch {
          return false
        }
      }, parsed.tileSelector)

      if (!tilesExist) {
        console.warn(`[dom-agent] Tile selector "${parsed.tileSelector}" matched 0 elements`)
        // Still return — the selector might work when people join
      }

      return {
        activeSpeakerSelector: parsed.activeSpeakerSelector,
        nameExtraction: parsed.nameExtraction,
        changingAttribute: parsed.changingAttribute || 'unknown',
        tileSelector: parsed.tileSelector,
      }
    } catch (err) {
      console.error(`[dom-agent] discoverSpeakerPatterns error:`, (err as Error).message)
      return null
    }
  }

  /* ---------------------------------------------------------------- */
  /*  findParticipantNames — Get all visible participant names         */
  /* ---------------------------------------------------------------- */

  /**
   * Ask the LLM to identify all participant names visible on the page.
   * Useful when DOM scraping methods fail.
   */
  async findParticipantNames(): Promise<string[]> {
    try {
      const snapshot = await getCleanDomSnapshot(this.page, undefined, 4)
      if (!snapshot) return []

      let screenshot: string | undefined
      try {
        const buf = await this.page.screenshot({
          encoding: 'base64',
          type: 'jpeg',
          quality: 40,
        }) as string
        screenshot = buf
      } catch { /* proceed without */ }

      const systemPrompt = `You are a DOM analysis agent. Extract all participant names visible in a Google Meet call. Return ONLY a JSON array of name strings. Do not include bot names like "Zerowing", "Captain", "Meeting Bot", or "You". Example: ["Alice Smith", "Bob Jones"]

If no names are found, return: []`

      const userPrompt = `Find all participant names in this Google Meet page.

Look for:
- data-self-name attributes
- aria-label attributes on participant tiles (name is before the first comma)
- Text elements within participant tile containers
- Caption sender names (data-sender-name)

DOM Snapshot:
${snapshot.slice(0, 8000)}`

      this.callCount++
      const result = await callLLM(this.config, systemPrompt, userPrompt, screenshot)

      const arrayMatch = result.match(/\[[\s\S]*\]/)
      if (!arrayMatch) return []

      const names: unknown[] = JSON.parse(arrayMatch[0])
      return names
        .filter((n): n is string => typeof n === 'string' && n.length > 0 && n.length < 60)
        .map(n => n.trim())
    } catch (err) {
      console.error(`[dom-agent] findParticipantNames error:`, (err as Error).message)
      return []
    }
  }
}
