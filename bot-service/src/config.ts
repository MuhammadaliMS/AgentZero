import 'dotenv/config'

export const config = {
  // Supabase
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',

  // Webhook
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookAuthToken: process.env.WEBHOOK_AUTH_TOKEN || '',

  // Groq
  groqApiKey: process.env.GROQ_API_KEY || '',

  // Bot behavior
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '30000', 10),
  joinBeforeMinutes: parseInt(process.env.JOIN_BEFORE_MINUTES || '1', 10),
  maxConcurrentBots: parseInt(process.env.MAX_CONCURRENT_BOTS || '3', 10),

  // Transcription
  transcriptionEngine: process.env.TRANSCRIPTION_ENGINE || 'groq',

  // Paths
  recordingDir: process.env.RECORDING_DIR || '/tmp/recordings',
  transcribeScript: process.env.TRANSCRIBE_SCRIPT || './scripts/transcribe.py',
} as const

export function validateConfig(): void {
  const required = ['supabaseUrl', 'supabaseServiceKey', 'webhookUrl', 'webhookAuthToken'] as const
  const missing = required.filter(key => !config[key])

  if (missing.length > 0) {
    console.error(`[config] Missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }

  console.log('[config] Configuration loaded:')
  console.log(`  Supabase: ${config.supabaseUrl.slice(0, 30)}...`)
  console.log(`  Webhook: ${config.webhookUrl.slice(0, 40)}...`)
  console.log(`  Poll interval: ${config.pollIntervalMs}ms`)
  console.log(`  Join before: ${config.joinBeforeMinutes} min`)
  console.log(`  Max concurrent: ${config.maxConcurrentBots}`)
  console.log(`  Transcription: ${config.transcriptionEngine}`)
}
