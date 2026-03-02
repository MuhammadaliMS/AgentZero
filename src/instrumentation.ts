export async function register() {
  // Configure DNS to use public resolvers when the local DNS server
  // can't resolve external hostnames (e.g. Supabase)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const dns = require('dns')
    dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1'])
  }

  // ─── Claude Agent SDK: writable config directory ────────────────
  // The SDK's debug logger (sdk.mjs) writes to ~/.claude/debug/ using
  // os.homedir(). On Vercel's serverless runtime, homedir resolves to
  // /home/sbx_user1051 which is read-only. The appendFileSync inside a
  // setTimeout causes an Uncaught Exception that crashes the function.
  //
  // Setting CLAUDE_CONFIG_DIR redirects the SDK's S6() config path to
  // /tmp/.claude, which is writable on Vercel's ephemeral filesystem.
  if (process.env.VERCEL && !process.env.CLAUDE_CONFIG_DIR) {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/.claude'
  }
}
