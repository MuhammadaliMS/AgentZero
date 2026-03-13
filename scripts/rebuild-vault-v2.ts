import { loadEnvConfig } from '@next/env'

import { createUntypedAdminClient } from '@/lib/supabase/admin'
import { rebuildVaultWorkspace } from '@/lib/evidence/store'

loadEnvConfig(process.cwd())

const supabase = createUntypedAdminClient()

function readFlag(name: string): string | null {
  const prefix = `--${name}=`
  const match = process.argv.find(arg => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

async function main() {
  const orgId = readFlag('org-id')
  if (!orgId) {
    throw new Error('Missing required flag: --org-id=<org-id>')
  }

  const artifactLimit = readFlag('artifact-limit')
  const pruneMissing = !process.argv.includes('--no-prune')

  const result = await rebuildVaultWorkspace(supabase, {
    orgId,
    pruneMissing,
    artifactLimit: artifactLimit ? Number(artifactLimit) : undefined,
  })

  console.log(JSON.stringify({
    ok: true,
    orgId,
    artifactCount: result.artifactCount,
    documentCount: result.documentCount,
    rebuiltPaths: result.rebuiltPaths.length,
    prunedPaths: result.prunedPaths.length,
  }, null, 2))
}

main().catch(error => {
  console.error('[rebuild-vault-v2] Failed:', error)
  process.exit(1)
})
