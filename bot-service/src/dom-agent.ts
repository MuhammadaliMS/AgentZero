/**
 * DomAgent — Agentic DOM Understanding via OpenAI Agents SDK
 *
 * Uses moonshotai/kimi-k2.5 via NVIDIA NIM with an agentic tool-calling loop.
 * The agent gets READ tools to inspect the live Puppeteer page (DOM snapshots,
 * test selectors, check styles, evaluate JS) and DECISION tools to submit
 * verified results. It iterates, self-corrects, and verifies before committing.
 *
 * Same pattern as chief-analyst-agent.ts / captain-agent.ts in the main app.
 *
 * Called sparingly — only when:
 *  1. Hardcoded selectors fail (fallback for clicking buttons)
 *  2. First time discovering speaker detection patterns (after joining)
 *  3. If discovered patterns stop working mid-session
 */

import { Agent, Runner, tool, OpenAIProvider, setOpenAIAPI } from '@openai/agents'
import { z } from 'zod'
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
  /** Base URL for NVIDIA NIM (default: https://integrate.api.nvidia.com/v1) */
  baseUrl?: string
}

/* ------------------------------------------------------------------ */
/*  DOM Snapshot Helpers (unchanged — reused as tool implementations)  */
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

        let text = ''
        if (el.childNodes.length <= 2) {
          for (const child of el.childNodes) {
            if (child.nodeType === 3) {
              const t = child.textContent?.trim()
              if (t && t.length > 0 && t.length < 60) {
                text += t
              }
            }
          }
        }

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
 */
async function getInteractiveSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const elements: string[] = []
    const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]'
    const els = document.querySelectorAll(interactiveSelectors)

    for (const el of els) {
      const rect = el.getBoundingClientRect()
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
/*  NVIDIA NIM / OpenRouter Provider Factory                           */
/* ------------------------------------------------------------------ */

function getDomAgentProvider(config: DomAgentConfig): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || 'https://integrate.api.nvidia.com/v1',
    useResponses: false, // NIM + OpenRouter use chat completions, not responses API
  })
}

/* ------------------------------------------------------------------ */
/*  Tool Factory — createDomTools(page)                                */
/* ------------------------------------------------------------------ */

interface ToolResults {
  elementSelector: string | null
  speakerPatterns: SpeakerPatterns | null
  participantNames: string[] | null
  clickSuccess: boolean | null
}

function createDomTools(page: Page) {
  // Closure-captured results — decision tools write here
  const results: ToolResults = {
    elementSelector: null,
    speakerPatterns: null,
    participantNames: null,
    clickSuccess: null,
  }

  // ══════ READ TOOLS ══════

  const getDomSnapshotTool = tool({
    name: 'get_dom_snapshot',
    description: 'Get a cleaned DOM snapshot of the page. Returns compact HTML with data-*, aria-*, computed styles on participant tiles. Use this to understand the overall page structure. Optionally specify a root CSS selector to focus on a subtree, and max depth (default 5).',
    parameters: z.object({
      root_selector: z.string().optional().describe('CSS selector for root element (default: document.body)'),
      max_depth: z.number().optional().default(5).describe('Max DOM traversal depth (default: 5)'),
    }),
    execute: async (args) => {
      try {
        const html = await getCleanDomSnapshot(page, args.root_selector || undefined, args.max_depth)
        if (!html) return 'DOM snapshot is empty — page may not be fully loaded.'
        return html.slice(0, 15000) // Cap at 15KB to stay within context
      } catch (e) {
        return `Error getting DOM snapshot: ${(e as Error).message.slice(0, 200)}`
      }
    },
  })

  const getInteractiveElementsTool = tool({
    name: 'get_interactive_elements',
    description: 'Get all visible interactive elements on the page (buttons, links, inputs, elements with role="button"). Returns each element\'s tag, attributes (id, class, aria-label, jsname, data-tooltip, etc.), and text content. Best for finding clickable UI elements.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const html = await getInteractiveSnapshot(page)
        if (!html) return 'No interactive elements found on page.'
        return html.slice(0, 10000)
      } catch (e) {
        return `Error getting interactive elements: ${(e as Error).message.slice(0, 200)}`
      }
    },
  })

  const takeScreenshotTool = tool({
    name: 'take_screenshot',
    description: 'Take a screenshot of the current page for visual context. Returns a base64-encoded JPEG image. Use this to see the visual layout, identify UI elements by appearance, or verify what the page looks like.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const buf = await page.screenshot({
          encoding: 'base64',
          type: 'jpeg',
          quality: 40,
        }) as string
        // Return as a data URL that multimodal models can interpret
        return `data:image/jpeg;base64,${buf}`
      } catch (e) {
        return `Screenshot failed: ${(e as Error).message.slice(0, 200)}`
      }
    },
  })

  const testSelectorTool = tool({
    name: 'test_selector',
    description: 'Test a CSS selector against the live DOM. Returns match count, and for each matched element: tag name, text content, visibility, and key attributes (id, class, aria-label, data-self-name, data-participant-id, data-is-speaking, data-sender-name, role, jsname, data-tooltip). ALWAYS use this to verify selectors before submitting them.',
    parameters: z.object({
      selector: z.string().describe('CSS selector to test'),
      max_results: z.number().optional().default(5).describe('Max elements to return details for (default: 5)'),
    }),
    execute: async (args) => {
      try {
        const result = await page.evaluate((sel: string, max: number) => {
          try {
            const els = document.querySelectorAll(sel)
            const items = Array.from(els).slice(0, max).map(el => {
              const rect = el.getBoundingClientRect()
              const tag = el.tagName.toLowerCase()
              const attrs: Record<string, string> = {}
              for (const attr of ['id', 'class', 'aria-label', 'data-self-name',
                'data-participant-id', 'data-requested-participant-id',
                'data-is-speaking', 'data-sender-name', 'role', 'jsname',
                'data-tooltip', 'aria-pressed', 'type', 'placeholder']) {
                const val = el.getAttribute(attr)
                if (val) attrs[attr] = val.slice(0, 80)
              }
              return {
                tag,
                text: el.textContent?.trim().slice(0, 80) || '',
                visible: rect.width > 0 && rect.height > 0,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                attrs,
              }
            })
            return { total: els.length, items }
          } catch (e) {
            return { error: (e as Error).message }
          }
        }, args.selector, args.max_results)
        return JSON.stringify(result, null, 2)
      } catch (e) {
        return `Error testing selector: ${(e as Error).message.slice(0, 200)}`
      }
    },
  })

  const getElementStylesTool = tool({
    name: 'get_element_styles',
    description: 'Get computed CSS styles for elements matching a selector. Returns border, outline, background color, and class list for each element. Critical for speaker detection — the active speaker typically has a different border/outline color. Compare styles between tiles to find the speaking indicator.',
    parameters: z.object({
      selector: z.string().describe('CSS selector to match elements'),
      max_results: z.number().optional().default(5).describe('Max elements to return (default: 5)'),
    }),
    execute: async (args) => {
      try {
        const result = await page.evaluate((sel: string, max: number) => {
          try {
            const els = document.querySelectorAll(sel)
            const items = Array.from(els).slice(0, max).map(el => {
              const style = window.getComputedStyle(el)
              const name = el.getAttribute('data-self-name')
                || (el.getAttribute('aria-label') || '').split(',')[0].trim()
                || el.textContent?.trim().slice(0, 40)
                || '(unnamed)'
              return {
                name,
                border: style.border,
                borderColor: style.borderColor,
                outline: style.outline,
                outlineColor: style.outlineColor,
                backgroundColor: style.backgroundColor,
                boxShadow: style.boxShadow?.slice(0, 100),
                classList: Array.from(el.classList).join(' ').slice(0, 120),
                dataSpeaking: el.getAttribute('data-is-speaking'),
              }
            })
            return { total: els.length, items }
          } catch (e) {
            return { error: (e as Error).message }
          }
        }, args.selector, args.max_results)
        return JSON.stringify(result, null, 2)
      } catch (e) {
        return `Error getting styles: ${(e as Error).message.slice(0, 200)}`
      }
    },
  })

  const evaluateExpressionTool = tool({
    name: 'evaluate_expression',
    description: 'Evaluate a JavaScript expression in the page context and return the result. The expression must return a JSON-serializable value. Use for ad-hoc DOM queries when the other tools are insufficient (e.g., extracting an array of names from specific elements).',
    parameters: z.object({
      expression: z.string().describe('JavaScript expression to evaluate (must return a serializable value)'),
    }),
    execute: async (args) => {
      try {
        // Wrap in a Function to eval safely
        const result = await page.evaluate((expr: string) => {
          try {
            // eslint-disable-next-line no-eval
            const val = eval(expr)
            return JSON.stringify(val, null, 2)
          } catch (e) {
            return `Eval error: ${(e as Error).message}`
          }
        }, args.expression)
        return typeof result === 'string' ? result.slice(0, 5000) : String(result)
      } catch (e) {
        return `Error evaluating expression: ${(e as Error).message.slice(0, 200)}`
      }
    },
  })

  // ══════ DECISION TOOLS ══════

  const submitElementSelectorTool = tool({
    name: 'submit_element_selector',
    description: 'Submit a verified CSS selector for the target element. Only call this AFTER verifying with test_selector that the selector matches exactly 1 visible element. Include your confidence level and reasoning.',
    parameters: z.object({
      selector: z.string().describe('The verified CSS selector'),
      confidence: z.number().min(0).max(1).describe('Confidence level 0.0-1.0'),
      reasoning: z.string().max(500).describe('Why this selector is correct'),
    }),
    execute: async (args) => {
      // Validate that selector actually matches a visible element
      const valid = await page.evaluate((sel: string) => {
        try {
          const el = document.querySelector(sel)
          if (!el) return { ok: false, reason: 'No element matched' }
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return { ok: false, reason: 'Element not visible' }
          return { ok: true }
        } catch (e) {
          return { ok: false, reason: (e as Error).message }
        }
      }, args.selector)

      if (!valid.ok) {
        return `Selector validation failed: ${valid.reason}. Try a different selector.`
      }

      results.elementSelector = args.selector
      return `Element selector submitted: "${args.selector}" (confidence: ${args.confidence})`
    },
  })

  const submitSpeakerPatternsTool = tool({
    name: 'submit_speaker_patterns',
    description: 'Submit discovered speaker detection patterns. Only call this AFTER verifying tile_selector matches participant tiles and you\'ve confirmed the active speaker indicator (border color, attribute, etc.). Include confidence and reasoning.',
    parameters: z.object({
      active_speaker_selector: z.string().describe('CSS selector for the element indicating active speaking'),
      name_extraction: z.string().describe('How to get the speaker name: "data-self-name", "aria-label", or a CSS sub-selector'),
      changing_attribute: z.string().describe('What changes when speaking: "data-is-speaking", "style.borderColor", "style.outline", "class"'),
      tile_selector: z.string().describe('CSS selector for individual participant tile containers'),
      confidence: z.number().min(0).max(1).describe('Confidence level 0.0-1.0'),
      reasoning: z.string().max(500).describe('Why these patterns are correct'),
    }),
    execute: async (args) => {
      // Validate tile selector matches elements
      const tileCount = await page.evaluate((sel: string) => {
        try {
          return document.querySelectorAll(sel).length
        } catch {
          return 0
        }
      }, args.tile_selector)

      if (tileCount === 0) {
        return `Tile selector "${args.tile_selector}" matched 0 elements. Try a different selector.`
      }

      results.speakerPatterns = {
        activeSpeakerSelector: args.active_speaker_selector,
        nameExtraction: args.name_extraction,
        changingAttribute: args.changing_attribute,
        tileSelector: args.tile_selector,
      }
      return `Speaker patterns submitted (${tileCount} tiles matched). Confidence: ${args.confidence}`
    },
  })

  const submitParticipantNamesTool = tool({
    name: 'submit_participant_names',
    description: 'Submit the list of participant names found in the meeting. Filter out bot names like "Zerowing", "Captain", "Meeting Bot", "You".',
    parameters: z.object({
      names: z.array(z.string()).describe('Array of participant names'),
      extraction_method: z.string().max(200).describe('How the names were extracted'),
    }),
    execute: async (args) => {
      const BOT_NAMES = ['zerowing', 'captain', 'meeting bot', 'you', 'bot']
      const filtered = args.names.filter(n =>
        n.length > 0 && n.length < 60 &&
        !BOT_NAMES.some(b => n.toLowerCase().includes(b))
      )
      results.participantNames = filtered
      return `Participant names submitted: [${filtered.join(', ')}] (${filtered.length} names, method: ${args.extraction_method})`
    },
  })

  const clickElementTool = tool({
    name: 'click_element',
    description: 'Click an element by CSS selector. Returns success or failure. Use test_selector first to verify the element exists and is visible before clicking.',
    parameters: z.object({
      selector: z.string().describe('CSS selector of the element to click'),
    }),
    execute: async (args) => {
      try {
        // Verify element exists and is visible first
        const check = await page.evaluate((sel: string) => {
          try {
            const el = document.querySelector(sel)
            if (!el) return { ok: false, reason: 'No element matched' }
            const rect = el.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) return { ok: false, reason: 'Element not visible' }
            return { ok: true, tag: el.tagName.toLowerCase(), text: el.textContent?.trim().slice(0, 40) }
          } catch (e) {
            return { ok: false, reason: (e as Error).message }
          }
        }, args.selector)

        if (!check.ok) {
          return `Cannot click — ${check.reason}. Try a different selector.`
        }

        await page.click(args.selector)
        results.clickSuccess = true
        return `Successfully clicked <${check.tag}>${check.text || ''}</${check.tag}>`
      } catch (e) {
        results.clickSuccess = false
        return `Click failed: ${(e as Error).message.slice(0, 200)}. Try a different selector.`
      }
    },
  })

  // ══════ Return all tools + result accessors ══════

  const readTools = [
    getDomSnapshotTool,
    getInteractiveElementsTool,
    takeScreenshotTool,
    testSelectorTool,
    getElementStylesTool,
    evaluateExpressionTool,
  ]

  return {
    readTools,
    submitElementSelector: submitElementSelectorTool,
    submitSpeakerPatterns: submitSpeakerPatternsTool,
    submitParticipantNames: submitParticipantNamesTool,
    clickElement: clickElementTool,
    getResults: () => results,
  }
}

/* ------------------------------------------------------------------ */
/*  System Prompts                                                      */
/* ------------------------------------------------------------------ */

const FIND_ELEMENT_PROMPT = `You are a DOM analysis agent with tools to inspect a live web page in real-time.

TASK: Find a specific UI element described by the user and submit its CSS selector.

STRATEGY:
1. Call get_interactive_elements to see all visible buttons, links, and inputs on the page.
2. Analyze the elements to identify candidates matching the user's description.
3. Use test_selector to verify your candidate — check it matches exactly 1 visible element.
4. If no match in interactive elements, use get_dom_snapshot for broader page context.
5. If still stuck, use take_screenshot for visual context.
6. When you've verified a selector, call submit_element_selector.

SELECTOR RULES:
- Prefer selectors using aria-label, jsname, data-* attributes, or id (these are stable).
- Avoid selectors relying ONLY on class names (Google changes them frequently).
- The selector must work with document.querySelector().
- ALWAYS verify with test_selector before submitting.
- The selector should match exactly 1 visible element.
- If you cannot find the element after several attempts, stop without submitting.`

const DISCOVER_SPEAKER_PROMPT = `You are a DOM analysis agent specializing in Google Meet's web interface.

TASK: Discover how to programmatically detect the active speaker in a Google Meet call.

BACKGROUND: In Google Meet, when someone speaks, their video tile gets a visual indicator — typically a colored border (blue/accent), an outline, a data attribute change, or a CSS class change. You need to find these patterns.

STRATEGY:
1. Call get_dom_snapshot to see the full meeting page DOM structure.
2. Look for participant video tiles — they typically have data-participant-id or data-requested-participant-id attributes.
3. Use test_selector on candidate tile selectors to verify they match actual tiles.
4. Call get_element_styles on the tile elements — compare border colors, outline colors, and box shadows between different tiles. The active speaker should have a distinctly different border/outline.
5. Check for data-self-name attributes on tiles (contain participant display names).
6. Check aria-label attributes (usually contain "name, microphone status, camera status").
7. Check for data-is-speaking attributes or similar boolean indicators.
8. Use evaluate_expression if you need to run custom JS to inspect specific properties.
9. When you're confident in ALL four patterns (tile selector, active speaker indicator, name extraction, changing attribute), call submit_speaker_patterns.

KEY INSIGHT: Compare styles across multiple tiles. The speaking person's tile will have a DIFFERENT border or outline color than non-speaking tiles. That difference IS the active speaker indicator.

VERIFICATION: Before submitting, make sure:
- tile_selector matches multiple elements (one per participant)
- You can extract names from tiles
- You've identified what changes on the active speaker's tile`

const FIND_AND_CLICK_PROMPT = `You are a DOM interaction agent with tools to find and click elements on a live web page.

TASK: Find the described element and click it successfully.

STRATEGY:
1. Call get_interactive_elements to see all clickable elements.
2. Identify the element matching the user's description.
3. Use test_selector to verify it exists and is visible.
4. Call click_element to click it.
5. If the first selector doesn't work, try alternative selectors.
6. If interactive elements don't show it, use get_dom_snapshot for a broader view.

SELECTOR RULES:
- Prefer aria-label, jsname, data-* attributes, or id selectors.
- Verify the element is visible (width > 0, height > 0) before clicking.
- If your first click attempt fails, try at least 2 alternative selectors before giving up.`

const FIND_PARTICIPANTS_PROMPT = `You are a DOM analysis agent. Extract all participant names visible in a Google Meet call.

STRATEGY:
1. Call get_dom_snapshot to see the page structure.
2. Look for these name sources:
   - data-self-name attributes on participant tiles
   - aria-label attributes on tiles (name is typically before the first comma)
   - data-sender-name attributes on caption elements
   - Text elements within participant tile containers
3. Use test_selector to verify your extraction selectors work.
4. Use evaluate_expression to extract names programmatically if needed. For example:
   Array.from(document.querySelectorAll('[data-self-name]')).map(el => el.getAttribute('data-self-name'))
5. Filter out bot names (Zerowing, Captain, Meeting Bot, You).
6. Call submit_participant_names with the verified list of names.

IMPORTANT: Verify names are real participant names, not UI labels or button text.`

/* ------------------------------------------------------------------ */
/*  DomAgent Class                                                     */
/* ------------------------------------------------------------------ */

export class DomAgent {
  private page: Page
  private config: DomAgentConfig
  private provider: OpenAIProvider
  private turnCount = 0

  constructor(page: Page, config: DomAgentConfig) {
    this.page = page
    this.config = config
    setOpenAIAPI('chat_completions') // Required for OpenRouter compatibility
    this.provider = getDomAgentProvider(config)
  }

  /** Total agentic turns used this session */
  get calls(): number {
    return this.turnCount
  }

  /* ---------------------------------------------------------------- */
  /*  findElement — Find a clickable element by description            */
  /* ---------------------------------------------------------------- */

  async findElement(description: string, context?: string): Promise<string | null> {
    try {
      const tools = createDomTools(this.page)
      const allTools = [...tools.readTools, tools.submitElementSelector]

      const agent = new Agent({
        name: 'DOM Element Finder',
        instructions: FIND_ELEMENT_PROMPT,
        model: this.config.model,
        tools: allTools,
      })

      const runner = new Runner({ modelProvider: this.provider })
      const userPrompt = `Find the element: "${description}"${context ? `\nPage context: ${context}` : ''}`

      console.log(`[dom-agent] findElement: "${description}" — starting agentic loop...`)

      await Promise.race([
        runner.run(agent, userPrompt, { maxTurns: 10 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('findElement timed out (30s)')), 30_000)
        ),
      ])

      const result = tools.getResults().elementSelector
      this.turnCount++

      if (result) {
        console.log(`[dom-agent] findElement: found "${result}"`)
      } else {
        console.log(`[dom-agent] findElement: could not find "${description}"`)
      }

      return result
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('timed out')) {
        console.warn(`[dom-agent] findElement timed out for "${description}"`)
      } else {
        console.error(`[dom-agent] findElement error:`, msg)
      }
      return null
    }
  }

  /* ---------------------------------------------------------------- */
  /*  findAndClick — Find an element and click it (agentic)            */
  /* ---------------------------------------------------------------- */

  async findAndClick(description: string, context?: string): Promise<boolean> {
    try {
      const tools = createDomTools(this.page)
      const allTools = [...tools.readTools, tools.clickElement]

      const agent = new Agent({
        name: 'DOM Click Agent',
        instructions: FIND_AND_CLICK_PROMPT,
        model: this.config.model,
        tools: allTools,
      })

      const runner = new Runner({ modelProvider: this.provider })
      const userPrompt = `Find and click: "${description}"${context ? `\nPage context: ${context}` : ''}`

      console.log(`[dom-agent] findAndClick: "${description}" — starting agentic loop...`)

      await Promise.race([
        runner.run(agent, userPrompt, { maxTurns: 10 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('findAndClick timed out (30s)')), 30_000)
        ),
      ])

      const success = tools.getResults().clickSuccess === true
      this.turnCount++

      if (success) {
        console.log(`[dom-agent] findAndClick: successfully clicked "${description}"`)
      } else {
        console.log(`[dom-agent] findAndClick: could not click "${description}"`)
      }

      return success
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('timed out')) {
        console.warn(`[dom-agent] findAndClick timed out for "${description}"`)
      } else {
        console.error(`[dom-agent] findAndClick error:`, msg)
      }
      return false
    }
  }

  /* ---------------------------------------------------------------- */
  /*  discoverSpeakerPatterns — Understand speaker detection           */
  /* ---------------------------------------------------------------- */

  async discoverSpeakerPatterns(): Promise<SpeakerPatterns | null> {
    try {
      const tools = createDomTools(this.page)
      const allTools = [...tools.readTools, tools.submitSpeakerPatterns]

      const agent = new Agent({
        name: 'Speaker Pattern Discoverer',
        instructions: DISCOVER_SPEAKER_PROMPT,
        model: this.config.model,
        tools: allTools,
      })

      const runner = new Runner({ modelProvider: this.provider })

      console.log(`[dom-agent] discoverSpeakerPatterns: starting agentic loop...`)

      await Promise.race([
        runner.run(agent, 'Analyze the Google Meet DOM and discover speaker detection patterns. Use your tools to inspect the page structure, test selectors, and compare element styles.', { maxTurns: 15 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('discoverSpeakerPatterns timed out (60s)')), 60_000)
        ),
      ])

      const result = tools.getResults().speakerPatterns
      this.turnCount++

      if (result) {
        console.log(`[dom-agent] discoverSpeakerPatterns: found patterns —`, JSON.stringify(result))
      } else {
        console.log(`[dom-agent] discoverSpeakerPatterns: could not discover patterns`)
      }

      return result
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('timed out')) {
        console.warn(`[dom-agent] discoverSpeakerPatterns timed out`)
      } else {
        console.error(`[dom-agent] discoverSpeakerPatterns error:`, msg)
      }
      return null
    }
  }

  /* ---------------------------------------------------------------- */
  /*  findParticipantNames — Get all visible participant names         */
  /* ---------------------------------------------------------------- */

  async findParticipantNames(): Promise<string[]> {
    try {
      const tools = createDomTools(this.page)
      const allTools = [...tools.readTools, tools.submitParticipantNames]

      const agent = new Agent({
        name: 'Participant Name Extractor',
        instructions: FIND_PARTICIPANTS_PROMPT,
        model: this.config.model,
        tools: allTools,
      })

      const runner = new Runner({ modelProvider: this.provider })

      console.log(`[dom-agent] findParticipantNames: starting agentic loop...`)

      await Promise.race([
        runner.run(agent, 'Find all participant names in this Google Meet call. Use your tools to inspect the DOM and extract names.', { maxTurns: 8 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('findParticipantNames timed out (30s)')), 30_000)
        ),
      ])

      const result = tools.getResults().participantNames ?? []
      this.turnCount++

      if (result.length > 0) {
        console.log(`[dom-agent] findParticipantNames: found [${result.join(', ')}]`)
      } else {
        console.log(`[dom-agent] findParticipantNames: no names found`)
      }

      return result
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('timed out')) {
        console.warn(`[dom-agent] findParticipantNames timed out`)
      } else {
        console.error(`[dom-agent] findParticipantNames error:`, msg)
      }
      return []
    }
  }
}
