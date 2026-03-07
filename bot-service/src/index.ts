/**
 * Zerowing Meeting Bot — VPS Entry Point
 *
 * Starts the meeting scheduler which polls Supabase for upcoming meetings
 * and spawns Puppeteer bot instances to join, record, and transcribe.
 *
 * Runs on a Hetzner VPS (~$6/mo) as a long-lived process via Docker + systemd.
 */

import { config, validateConfig } from './config.js'
import { MeetingScheduler } from './scheduler.js'

console.log('╔══════════════════════════════════════════╗')
console.log('║  Zerowing Meeting Bot v1.0               ║')
console.log('╚══════════════════════════════════════════╝')

// Validate environment
validateConfig()

// Start scheduler
const scheduler = new MeetingScheduler()
scheduler.start()

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`\n[main] Received ${signal}. Shutting down gracefully...`)
  scheduler.stop()

  // Give bots 10s to clean up
  setTimeout(() => {
    console.log('[main] Force exit.')
    process.exit(0)
  }, 10000)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Keep alive
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err)
  // Don't crash — log and continue
})

process.on('unhandledRejection', (err) => {
  console.error('[main] Unhandled rejection:', err)
})

console.log(`[main] Bot running. Polling every ${config.pollIntervalMs / 1000}s...`)
