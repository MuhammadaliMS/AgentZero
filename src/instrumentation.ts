export async function register() {
  // Configure DNS to use public resolvers when the local DNS server
  // can't resolve external hostnames (e.g. Supabase)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const dns = require('dns')
    dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1'])
  }
}
