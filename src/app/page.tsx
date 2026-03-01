import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function HomePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Check if onboarding is complete
  const { data: onboarding } = await supabase
    .from('onboarding_state')
    .select('is_complete')
    .eq('user_id', user.id)
    .single()

  if (!onboarding?.is_complete) {
    redirect('/onboarding')
  }

  redirect('/chat')
}
