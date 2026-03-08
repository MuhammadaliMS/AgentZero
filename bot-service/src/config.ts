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

  // Google Account (for authenticated meeting joins)
  googleAccountUser: process.env.GOOGLE_ACCOUNT_USER || '',
  googleAccountPassword: process.env.GOOGLE_ACCOUNT_PASSWORD || '',

  // DOM Agent (LLM-powered DOM understanding)
  // Priority: NVIDIA NIM → OpenRouter
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  domAgentApiKey: process.env.NVIDIA_API_KEY || process.env.OPENROUTER_API_KEY || '',
  domAgentBaseUrl: process.env.NVIDIA_API_KEY
    ? 'https://integrate.api.nvidia.com/v1'
    : 'https://openrouter.ai/api/v1',
  domAgentModel: process.env.DOM_AGENT_MODEL || (process.env.NVIDIA_API_KEY
    ? 'moonshotai/kimi-k2.5'
    : 'minimax/minimax-m2.5'),
  domAgentEnabled: process.env.DOM_AGENT_ENABLED !== 'false', // enabled by default

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
  console.log(`  Google account: ${config.googleAccountUser ? config.googleAccountUser : '(not set — joining as guest)'}`)
  const domProvider = config.nvidiaApiKey ? 'nvidia' : config.openrouterApiKey ? 'openrouter' : 'none'
  console.log(`  DOM Agent: ${config.domAgentEnabled && config.domAgentApiKey ? `enabled (${config.domAgentModel} via ${domProvider})` : 'disabled'}`)
}
