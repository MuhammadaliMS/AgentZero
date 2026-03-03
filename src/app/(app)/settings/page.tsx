'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { SDKToggle } from '@/components/sdk-toggle'
import type { Database } from '@/types/database'

type Profile = Database['public']['Tables']['profiles']['Row']
type Organization = Database['public']['Tables']['organizations']['Row']

interface ProfileData {
  full_name: string
  email: string
  title: string
  timezone: string
  communication_style: string
  notification_channel: string
  settings: Record<string, unknown>
}

interface OrgData {
  name: string
  domain: string
  settings: Record<string, unknown>
}

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Anchorage', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (HT)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
]

const COMMUNICATION_STYLES = [
  {
    value: 'executive',
    label: 'Executive',
    description: 'Concise, high-level summaries with key metrics and decisions',
  },
  {
    value: 'detailed',
    label: 'Detailed',
    description: 'Comprehensive analysis with context, data, and recommendations',
  },
  {
    value: 'casual',
    label: 'Casual',
    description: 'Conversational tone with clear, approachable language',
  },
]

const NOTIFICATION_CHANNELS = [
  { value: 'slack', label: 'Slack', description: 'Receive briefs and nudges in Slack DMs' },
  { value: 'email', label: 'Email', description: 'Receive briefs and nudges via email' },
  { value: 'both', label: 'Both', description: 'Receive via Slack and email' },
]

export default function SettingsPage() {
  const router = useRouter()
  const supabase = createClient()

  const [profile, setProfile] = useState<ProfileData>({
    full_name: '',
    email: '',
    title: '',
    timezone: 'America/New_York',
    communication_style: 'executive',
    notification_channel: 'slack',
    settings: {},
  })
  const [org, setOrg] = useState<OrgData>({
    name: '',
    domain: '',
    settings: {},
  })
  const [orgId, setOrgId] = useState<string>('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingOrg, setSavingOrg] = useState(false)
  const [showSignOutDialog, setShowSignOutDialog] = useState(false)
  const [briefTime, setBriefTime] = useState('07:00')
  const [eodTime, setEodTime] = useState('17:00')
  const [showThinking, setShowThinking] = useState(true)
  const [weeklyBriefDay, setWeeklyBriefDay] = useState('monday')

  const loadData = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: profileData } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (profileData) {
      const p = profileData as Profile
      const settings = (p.settings || {}) as Record<string, unknown>
      setProfile({
        full_name: p.full_name || '',
        email: p.email || '',
        title: p.title || '',
        timezone: p.timezone || 'America/New_York',
        communication_style: p.communication_style || 'executive',
        notification_channel: p.notification_channel || 'slack',
        settings,
      })
      setBriefTime((settings.morning_brief_time as string) || '07:00')
      setEodTime((settings.eod_wrap_time as string) || '17:00')
      setShowThinking((settings.show_thinking !== false) as boolean)
      setWeeklyBriefDay((settings.weekly_brief_day as string) || 'monday')
      setOrgId(p.org_id)

      // Load org data
      const { data: orgData } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', p.org_id)
        .single()

      if (orgData) {
        const o = orgData as Organization
        setOrg({
          name: o.name || '',
          domain: o.domain || '',
          settings: (o.settings || {}) as Record<string, unknown>,
        })
      }
    }
  }, [supabase])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleSaveProfile = async () => {
    setSavingProfile(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const updatedSettings = {
        ...profile.settings,
        morning_brief_time: briefTime,
        eod_wrap_time: eodTime,
        show_thinking: showThinking,
        weekly_brief_day: weeklyBriefDay,
      }

      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: profile.full_name,
          title: profile.title,
          timezone: profile.timezone,
          communication_style: profile.communication_style,
          notification_channel: profile.notification_channel,
          settings: updatedSettings,
        })
        .eq('id', user.id)

      if (error) throw error
      toast.success('Profile settings saved')
    } catch (err) {
      toast.error('Failed to save profile settings')
      console.error(err)
    } finally {
      setSavingProfile(false)
    }
  }

  const handleSaveOrg = async () => {
    setSavingOrg(true)
    try {
      if (!orgId) return

      const { error } = await supabase
        .from('organizations')
        .update({
          name: org.name,
          domain: org.domain || null,
        })
        .eq('id', orgId)

      if (error) throw error
      toast.success('Organization settings saved')
    } catch (err) {
      toast.error('Failed to save organization settings')
      console.error(err)
    } finally {
      setSavingOrg(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your profile, preferences, and organization settings.
        </p>
      </div>

      <div className="space-y-8">
        {/* ── Profile ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Profile</CardTitle>
            <CardDescription>Your personal information and role</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Full Name</Label>
                <Input
                  id="name"
                  value={profile.full_name}
                  onChange={(e) => setProfile((p) => ({ ...p, full_name: e.target.value }))}
                  placeholder="Jane Doe"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={profile.email} disabled className="bg-muted" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={profile.title}
                  onChange={(e) => setProfile((p) => ({ ...p, title: e.target.value }))}
                  placeholder="e.g., CISO, VP Security"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="timezone">Timezone</Label>
                <select
                  id="timezone"
                  value={profile.timezone}
                  onChange={(e) => setProfile((p) => ({ ...p, timezone: e.target.value }))}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Communication Preferences ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Communication Preferences</CardTitle>
            <CardDescription>How your Captain communicates with you</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <Label>Communication Style</Label>
              <div className="grid gap-2">
                {COMMUNICATION_STYLES.map((style) => (
                  <button
                    key={style.value}
                    type="button"
                    onClick={() => setProfile((p) => ({ ...p, communication_style: style.value }))}
                    className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                      profile.communication_style === style.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-foreground/20'
                    }`}
                  >
                    <div
                      className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${
                        profile.communication_style === style.value
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground/30'
                      }`}
                    >
                      {profile.communication_style === style.value && (
                        <div className="flex h-full items-center justify-center">
                          <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{style.label}</p>
                      <p className="text-xs text-muted-foreground">{style.description}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <Label>Notification Channel</Label>
              <div className="flex flex-wrap gap-2">
                {NOTIFICATION_CHANNELS.map((channel) => (
                  <Button
                    key={channel.value}
                    variant={profile.notification_channel === channel.value ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setProfile((p) => ({ ...p, notification_channel: channel.value }))}
                  >
                    {channel.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {NOTIFICATION_CHANNELS.find((c) => c.value === profile.notification_channel)?.description}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Agent Preferences ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Agent Preferences</CardTitle>
            <CardDescription>Configure your Captain&apos;s behavior</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="morning-brief">Morning Brief Time</Label>
                <Input
                  id="morning-brief"
                  type="time"
                  value={briefTime}
                  onChange={(e) => setBriefTime(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Daily brief delivered to your {profile.notification_channel === 'both' ? 'Slack & email' : profile.notification_channel}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="eod-wrap">EOD Wrap Time</Label>
                <Input
                  id="eod-wrap"
                  type="time"
                  value={eodTime}
                  onChange={(e) => setEodTime(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  End-of-day summary with action items
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="weekly-brief-day">Weekly Brief Day</Label>
              <select
                id="weekly-brief-day"
                value={weeklyBriefDay}
                onChange={(e) => setWeeklyBriefDay(e.target.value)}
                className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="monday">Monday</option>
                <option value="tuesday">Tuesday</option>
                <option value="wednesday">Wednesday</option>
                <option value="thursday">Thursday</option>
                <option value="friday">Friday</option>
                <option value="sunday">Sunday</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Weekly strategic summary with commitment tracking
              </p>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Show Agent Thinking</p>
                <p className="text-xs text-muted-foreground">
                  Display reasoning steps and tool usage in the chat
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showThinking}
                onClick={() => setShowThinking(!showThinking)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
                  showThinking ? 'bg-primary' : 'bg-muted'
                }`}
              >
                <span
                  className={`pointer-events-none block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform ${
                    showThinking ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            <Separator />

            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">AI Model</p>
                <p className="text-xs text-muted-foreground">
                  Choose which AI model powers your Captain. Changes take effect on the next message.
                </p>
              </div>
              <SDKToggle variant="full" />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSaveProfile} disabled={savingProfile}>
            {savingProfile ? 'Saving...' : 'Save Profile & Preferences'}
          </Button>
        </div>

        <Separator />

        {/* ── Organization ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Organization</CardTitle>
            <CardDescription>Manage your organization settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="org-name">Organization Name</Label>
                <Input
                  id="org-name"
                  value={org.name}
                  onChange={(e) => setOrg((o) => ({ ...o, name: e.target.value }))}
                  placeholder="Acme Corp"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-domain">Domain</Label>
                <Input
                  id="org-domain"
                  value={org.domain}
                  onChange={(e) => setOrg((o) => ({ ...o, domain: e.target.value }))}
                  placeholder="acme.com"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveOrg} disabled={savingOrg} variant="outline">
                {savingOrg ? 'Saving...' : 'Save Organization'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Connected Integrations Quick View ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Connected Integrations</CardTitle>
            <CardDescription>Quick overview of your connected tools</CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectedIntegrationsSummary />
          </CardContent>
        </Card>

        <Separator />

        {/* ── Danger Zone ── */}
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-lg text-destructive">Danger Zone</CardTitle>
            <CardDescription>Irreversible actions that affect your account</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-destructive/20 p-4">
              <div>
                <p className="text-sm font-medium">Sign Out</p>
                <p className="text-xs text-muted-foreground">Sign out of your account on this device</p>
              </div>
              <Dialog open={showSignOutDialog} onOpenChange={setShowSignOutDialog}>
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    Sign Out
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Sign out?</DialogTitle>
                    <DialogDescription>
                      You will be signed out and redirected to the login page. Any unsaved changes will be lost.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter className="gap-2 sm:gap-0">
                    <Button variant="outline" onClick={() => setShowSignOutDialog(false)}>
                      Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleSignOut}>
                      Sign Out
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────
 * Inline sub-component: shows a compact summary of
 * connected integrations within the settings page
 * ──────────────────────────────────────────────────── */
function ConnectedIntegrationsSummary() {
  const supabase = createClient()
  const [integrations, setIntegrations] = useState<
    Array<{ key: string; name: string; category: string; health_status: string; connected_email?: string }>
  >([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('organization_integrations')
        .select('*, integrations!inner(key, name, category)')
        .eq('is_active', true)

      type OrgIntRow = {
        health_status: string
        user_metadata: Record<string, unknown> | null
        integrations: { key: string; name: string; category: string }
      }

      const rows = (data || []) as unknown as OrgIntRow[]
      setIntegrations(
        rows.map((r) => ({
          key: r.integrations.key,
          name: r.integrations.name,
          category: r.integrations.category,
          health_status: r.health_status || 'unknown',
          connected_email: (r.user_metadata?.connected_email as string) || undefined,
        }))
      )
      setLoading(false)
    }
    load()
  }, [supabase])

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-muted" />
        ))}
      </div>
    )
  }

  if (integrations.length === 0) {
    return (
      <div className="py-4 text-center">
        <p className="text-sm text-muted-foreground">No integrations connected yet.</p>
        <a href="/integrations" className="text-sm text-primary hover:underline">
          Connect your first integration
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {integrations.map((integration) => (
        <div
          key={integration.key}
          className="flex items-center justify-between rounded-lg border px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-muted text-xs font-bold">
              {integration.name[0]}
            </div>
            <div>
              <p className="text-sm font-medium">{integration.name}</p>
              {integration.connected_email && (
                <p className="text-xs text-muted-foreground">{integration.connected_email}</p>
              )}
            </div>
          </div>
          <Badge
            variant={integration.health_status === 'healthy' ? 'default' : 'secondary'}
            className={`text-[10px] ${
              integration.health_status === 'healthy'
                ? 'border-green-500/50 bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'
                : integration.health_status === 'unhealthy'
                ? 'border-red-500/50 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
                : 'border-yellow-500/50 bg-yellow-50 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-400'
            }`}
          >
            {integration.health_status}
          </Badge>
        </div>
      ))}
      <div className="pt-2">
        <a href="/integrations" className="text-xs text-primary hover:underline">
          Manage all integrations &rarr;
        </a>
      </div>
    </div>
  )
}
