import dns from 'dns'
import https from 'https'
import http from 'http'

const resolver = new dns.Resolver()
resolver.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1'])

// Cache resolved IPs for 5 minutes
const dnsCache = new Map<string, { ip: string; expires: number }>()

function resolveHostname(hostname: string): Promise<string> {
  const cached = dnsCache.get(hostname)
  if (cached && cached.expires > Date.now()) {
    return Promise.resolve(cached.ip)
  }

  return new Promise((resolve, reject) => {
    resolver.resolve4(hostname, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        console.error(`DNS resolve failed for ${hostname}:`, err)
        reject(err || new Error(`No addresses found for ${hostname}`))
        return
      }
      const ip = addresses[0]
      dnsCache.set(hostname, { ip, expires: Date.now() + 5 * 60 * 1000 })
      resolve(ip)
    })
  })
}

/**
 * Makes an HTTPS request using public DNS resolvers (8.8.8.8)
 * instead of the system resolver. Resolves the hostname first,
 * then connects directly to the IP with proper SNI.
 */
export async function httpsRequest(
  url: string,
  options: {
    method: string
    headers: Record<string, string>
    body?: string
  }
): Promise<{ status: number; data: any; headers: Record<string, string> }> {
  const parsed = new URL(url)
  const hostname = parsed.hostname

  const ip = await resolveHostname(hostname)

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: ip,
        port: parsed.port ? parseInt(parsed.port) : 443,
        path: parsed.pathname + parsed.search,
        method: options.method,
        headers: {
          ...options.headers,
          Host: hostname,
        },
        servername: hostname,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => {
          let data: any
          try {
            data = JSON.parse(body)
          } catch {
            data = body
          }
          const respHeaders: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') respHeaders[key] = value
          }
          resolve({ status: res.statusCode || 500, data, headers: respHeaders })
        })
      }
    )

    req.on('error', (err) => {
      console.error(`HTTPS request failed to ${hostname} (${ip}):`, err)
      reject(err)
    })

    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

/**
 * A fetch-compatible function that resolves DNS through public DNS servers.
 * Can be passed as `global.fetch` to the Supabase client so all its
 * internal requests bypass the broken system DNS resolver.
 */
export async function customFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === 'string'
    ? new URL(input)
    : input instanceof URL
      ? input
      : new URL(input.url)

  const hostname = url.hostname

  // Only intercept requests to supabase — let everything else use default fetch
  if (!hostname.includes('supabase.co')) {
    return globalThis.fetch(input, init)
  }

  let ip: string
  try {
    ip = await resolveHostname(hostname)
  } catch {
    // If custom DNS fails, try default fetch as fallback
    return globalThis.fetch(input, init)
  }

  const isHttps = url.protocol === 'https:'
  const port = url.port ? parseInt(url.port) : isHttps ? 443 : 80

  // Extract method, headers, body from init
  const method = init?.method || 'GET'
  const reqHeaders: Record<string, string> = { Host: hostname }

  if (init?.headers) {
    const h = new Headers(init.headers)
    h.forEach((value, key) => {
      reqHeaders[key] = value
    })
  }

  // Ensure Host header is set
  reqHeaders['Host'] = hostname

  let bodyStr: string | undefined
  if (init?.body) {
    if (typeof init.body === 'string') {
      bodyStr = init.body
    } else if (init.body instanceof ArrayBuffer) {
      bodyStr = Buffer.from(init.body).toString()
    } else {
      bodyStr = String(init.body)
    }
  }

  return new Promise<Response>((resolve, reject) => {
    const requestModule = isHttps ? https : http
    const req = requestModule.request(
      {
        host: ip,
        port,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
        ...(isHttps ? { servername: hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) {
              if (Array.isArray(value)) {
                value.forEach(v => responseHeaders.append(key, v))
              } else {
                responseHeaders.set(key, value)
              }
            }
          }
          const status = res.statusCode || 200
          // 204/304 responses must not have a body per HTTP spec
          const responseBody = (status === 204 || status === 304) ? null : body
          resolve(new Response(responseBody, {
            status,
            statusText: res.statusMessage || '',
            headers: responseHeaders,
          }))
        })
      }
    )

    req.on('error', reject)

    if (bodyStr) {
      req.write(bodyStr)
    }
    req.end()
  })
}
