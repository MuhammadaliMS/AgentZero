import { createClient } from '@/lib/supabase/server'
import { createUntypedAdminClient } from '@/lib/supabase/admin'

/**
 * Authenticate the current user and resolve their org id for evidence APIs.
 */
export async function getAuthenticatedEvidenceContext(): Promise<{
  orgId: string
  admin: ReturnType<typeof createUntypedAdminClient>
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    throw new Error('Unauthorized')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile?.org_id) {
    throw new Error('Profile not found')
  }

  return {
    orgId: profile.org_id,
    admin: createUntypedAdminClient(),
  }
}
