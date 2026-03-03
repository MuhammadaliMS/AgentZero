import crypto from 'crypto'

const SLACK_SIGNING_SECRET = (process.env.SLACK_SIGNING_SECRET || '').trim()

/**
 * Verify that a request came from Slack using HMAC-SHA256
 */
export function verifySlackRequest(
  body: string,
  timestamp: string,
  signature: string
): boolean {
  if (!SLACK_SIGNING_SECRET) {
    console.error('SLACK_SIGNING_SECRET is not set')
    return false
  }

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false
  }

  const sigBasestring = `v0:${timestamp}:${body}`
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
  hmac.update(sigBasestring)
  const computed = `v0=${hmac.digest('hex')}`

  const computedBuf = Buffer.from(computed)
  const signatureBuf = Buffer.from(signature)

  // Length mismatch means invalid signature — return false without throwing RangeError
  if (computedBuf.length !== signatureBuf.length) {
    return false
  }

  return crypto.timingSafeEqual(computedBuf, signatureBuf)
}
