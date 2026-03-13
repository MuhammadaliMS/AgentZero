'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import {
  Settings, User, Bell, Bot, Building2, Plug, Video,
  AlertTriangle, LogOut, ChevronRight, ExternalLink,
} from 'lucide-react'
import type { Database } from '@/types/database'
import type { JoinMode, TranscriptionEngine } from '@/types/meetings'

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
  { value: 'executive', label: 'Executive', description: 'Concise, high-level summaries with key metrics and decisions' },
  { value: 'detailed', label: 'Detailed', description: 'Comprehensive analysis with context, data, and recommendations' },
  { value: 'casual', label: 'Casual', description: 'Conversational tone with clear, approachable language' },
]

const NOTIFICATION_CHANNELS = [
  { value: 'slack', label: 'Slack', description: 'Receive briefs and nudges in Slack DMs' },
  { value: 'email', label: 'Email', description: 'Receive briefs and nudges via email' },
  { value: 'both', label: 'Both', description: 'Receive via Slack and email' },
]

/* ─── Reusable section wrapper ─────────────────────────────────────── */

function Section({
  icon: Icon,
  title,
  description,
  children,
  trailing,
  className = '',
}: {
  icon: React.ElementType
  title: string
  description: string
  children: React.ReactNode
  trailing?: React.ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-xl border border-border/50 bg-card ${className}`}>
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border/40">
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Icon className="h-4 w-4 text-primary" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground truncate">{description}</p>
          </div>
        </div>
        {trailing}
      </div>
      <div className="px-5 py-5">
        {children}
      </div>
    </section>
  )
}

/* ─── Toggle switch ─────────────────────────────────────────────────── */

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2
        ${checked ? 'bg-primary' : 'bg-muted'}`}
    >
      <span
        className={`pointer-events-none block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

/* ─── Radio option ──────────────────────────────────────────────────── */

function RadioOption({
  selected,
  onClick,
  label,
  description,
}: {
  selected: boolean
  onClick: () => void
  label: string
  description: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-start gap-3 rounded-lg border p-3 text-left cursor-pointer transition-all duration-200
        ${selected
          ? 'border-primary/40 bg-primary/5 ring-1 ring-primary/20'
          : 'border-border/50 hover:border-border hover:bg-muted/30'
        }`}
    >
      <div
        className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors duration-200 ${
          selected ? 'border-primary bg-primary' : 'border-muted-foreground/30'
        }`}
      >
        {selected && (
          <div className="flex h-full items-center justify-center">
            <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
          </div>
        )}
      </div>
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}

/* ─── Divider ───────────────────────────────────────────────────────── */

function Divider() {
  return <div className="border-t border-border/40" />
}

/* ─── Page ──────────────────────────────────────────────────────────── */

export default function SettingsPage() {
  const router = useRouter()
  const supabase = createClient()

  const [profile, setProfile] = useState<ProfileData>({
    full_name: '', email: '', title: '', timezone: 'America/New_York',
    communication_style: 'executive', notification_channel: 'slack', settings: {},
  })
  const [org, setOrg] = useState<OrgData>({ name: '', domain: '', settings: {} })
  const [orgId, setOrgId] = useState<string>('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingOrg, setSavingOrg] = useState(false)
  const [showSignOutDialog, setShowSignOutDialog] = useState(false)
  const [briefTime, setBriefTime] = useState('07:00')
  const [eodTime, setEodTime] = useState('17:00')
  const [showThinking, setShowThinking] = useState(true)
  const [weeklyBriefDay, setWeeklyBriefDay] = useState('monday')
  const [focusTopics, setFocusTopics] = useState('')
  const [deprioritizedTopics, setDeprioritizedTopics] = useState('')
  const [focusInstructions, setFocusInstructions] = useState('')

  // Meeting bot config state
  const [botEnabled, setBotEnabled] = useState(false)
  const [joinMode, setJoinMode] = useState<JoinMode>('all')
  const [minAttendees, setMinAttendees] = useState(2)
  const [recordLabel, setRecordLabel] = useState('[record]')
  const [transcriptionEngine, setTranscriptionEngine] = useState<TranscriptionEngine>('groq_whisper')
  const [autoSummarize, setAutoSummarize] = useState(true)
  const [notifySlack, setNotifySlack] = useState(true)
  const [notifyEmail, setNotifyEmail] = useState(false)
  const [blocklistPatterns, setBlocklistPatterns] = useState('')
  const [savingBot, setSavingBot] = useState(false)
  const [botConfigLoaded, setBotConfigLoaded] = useState(false)

  const loadData = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: profileData } = await supabase.from('profiles').select('*').eq('id', user.id).single()

    if (profileData) {
      const p = profileData as Profile
      const settings = (p.settings || {}) as Record<string, unknown>
      setProfile({
        full_name: p.full_name || '', email: p.email || '', title: p.title || '',
        timezone: p.timezone || 'America/New_York', communication_style: p.communication_style || 'executive',
        notification_channel: p.notification_channel || 'slack', settings,
      })
      setBriefTime((settings.morning_brief_time as string) || '07:00')
      setEodTime((settings.eod_wrap_time as string) || '17:00')
      setShowThinking((settings.show_thinking !== false) as boolean)
      setWeeklyBriefDay((settings.weekly_brief_day as string) || 'monday')
      setOrgId(p.org_id)

      const { data: orgData } = await supabase.from('organizations').select('*').eq('id', p.org_id).single()
      if (orgData) {
        const o = orgData as Organization
        const orgSettings = (o.settings || {}) as Record<string, unknown>
        setOrg({ name: o.name || '', domain: o.domain || '', settings: orgSettings })
        setFocusTopics(Array.isArray(orgSettings.chief_focus_topics) ? orgSettings.chief_focus_topics.join('\n') : '')
        setDeprioritizedTopics(Array.isArray(orgSettings.chief_deprioritized_topics) ? orgSettings.chief_deprioritized_topics.join('\n') : '')
        setFocusInstructions((orgSettings.chief_focus_instructions as string) || '')
      }

      const { data: botConfig } = await (supabase as any).from('meeting_bot_config').select('*').eq('org_id', p.org_id).single()
      if (botConfig) {
        setBotEnabled(botConfig.enabled ?? false)
        setJoinMode((botConfig.join_mode as JoinMode) || 'all')
        setMinAttendees(botConfig.min_attendees ?? 2)
        setRecordLabel(botConfig.record_label || '[record]')
        setTranscriptionEngine((botConfig.transcription_engine as TranscriptionEngine) || 'groq_whisper')
        setAutoSummarize(botConfig.auto_summarize ?? true)
        setNotifySlack(botConfig.notify_via_slack ?? true)
        setNotifyEmail(botConfig.notify_via_email ?? false)
        setBlocklistPatterns((botConfig.blocklist_patterns || []).join('\n'))
      }
      setBotConfigLoaded(true)
    }
  }, [supabase])

  useEffect(() => { loadData() }, [loadData])

  const handleSaveProfile = async () => {
    setSavingProfile(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const updatedSettings = {
        ...profile.settings,
        morning_brief_time: briefTime, eod_wrap_time: eodTime,
        show_thinking: showThinking, weekly_brief_day: weeklyBriefDay,
      }

      const { error } = await supabase.from('profiles').update({
        full_name: profile.full_name, title: profile.title, timezone: profile.timezone,
        communication_style: profile.communication_style, notification_channel: profile.notification_channel,
        settings: updatedSettings,
      }).eq('id', user.id)

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
      const updatedSettings = {
        ...org.settings,
        chief_focus_topics: focusTopics.split('\n').map((value) => value.trim()).filter(Boolean),
        chief_deprioritized_topics: deprioritizedTopics.split('\n').map((value) => value.trim()).filter(Boolean),
        chief_focus_instructions: focusInstructions.trim() || null,
      }
      const { error } = await supabase.from('organizations').update({
        name: org.name, domain: org.domain || null, settings: updatedSettings,
      }).eq('id', orgId)
      if (error) throw error
      toast.success('Organization settings saved')
    } catch (err) {
      toast.error('Failed to save organization settings')
      console.error(err)
    } finally {
      setSavingOrg(false)
    }
  }

  const handleSaveBotConfig = async () => {
    setSavingBot(true)
    try {
      if (!orgId) return
      const patterns = blocklistPatterns.split('\n').map((p) => p.trim()).filter(Boolean)
      const { error } = await (supabase as any).from('meeting_bot_config').upsert({
        org_id: orgId, enabled: botEnabled, join_mode: joinMode,
        min_attendees: minAttendees, record_label: recordLabel,
        transcription_engine: transcriptionEngine, auto_summarize: autoSummarize,
        notify_via_slack: notifySlack, notify_via_email: notifyEmail,
        blocklist_patterns: patterns,
      }, { onConflict: 'org_id' })
      if (error) throw error
      toast.success('Meeting bot settings saved')
    } catch (err) {
      toast.error('Failed to save meeting bot settings')
      console.error(err)
    } finally {
      setSavingBot(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-10">
      {/* ── Header ── */}
      <header className="mb-8 sm:mb-10">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <Settings className="h-5 w-5 text-primary" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="text-[13px] text-muted-foreground leading-none mt-0.5">
              Manage your profile, preferences &amp; organization
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-6">
        {/* ── Profile ── */}
        <Section icon={User} title="Profile" description="Your personal information and role">
          <div className="space-y-4">
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
                <Input id="email" value={profile.email} disabled className="bg-muted/50" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={profile.title}
                  onChange={(e) => setProfile((p) => ({ ...p, title: e.target.value }))}
                  placeholder="e.g., Senior PM, VP Product"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="timezone">Timezone</Label>
                <select
                  id="timezone"
                  value={profile.timezone}
                  onChange={(e) => setProfile((p) => ({ ...p, timezone: e.target.value }))}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 cursor-pointer"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </Section>

        {/* ── Communication Preferences ── */}
        <Section icon={Bell} title="Communication Preferences" description="How your Captain communicates with you">
          <div className="space-y-6">
            <div className="space-y-3">
              <Label>Communication Style</Label>
              <div className="grid gap-2">
                {COMMUNICATION_STYLES.map((style) => (
                  <RadioOption
                    key={style.value}
                    selected={profile.communication_style === style.value}
                    onClick={() => setProfile((p) => ({ ...p, communication_style: style.value }))}
                    label={style.label}
                    description={style.description}
                  />
                ))}
              </div>
            </div>

            <Divider />

            <div className="space-y-3">
              <Label>Notification Channel</Label>
              <nav className="flex gap-0.5 rounded-lg bg-muted/50 p-0.5 w-fit" role="tablist">
                {NOTIFICATION_CHANNELS.map((channel) => (
                  <button
                    key={channel.value}
                    role="tab"
                    aria-selected={profile.notification_channel === channel.value}
                    onClick={() => setProfile((p) => ({ ...p, notification_channel: channel.value }))}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium cursor-pointer transition-all duration-200
                      ${profile.notification_channel === channel.value
                        ? 'bg-card text-foreground shadow-sm ring-1 ring-border/60'
                        : 'text-muted-foreground hover:text-foreground'
                      }`}
                  >
                    {channel.label}
                  </button>
                ))}
              </nav>
              <p className="text-xs text-muted-foreground">
                {NOTIFICATION_CHANNELS.find((c) => c.value === profile.notification_channel)?.description}
              </p>
            </div>
          </div>
        </Section>

        {/* ── Agent Preferences ── */}
        <Section icon={Bot} title="Agent Preferences" description="Configure your Captain's behavior">
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="morning-brief">Morning Brief Time</Label>
                <Input id="morning-brief" type="time" value={briefTime} onChange={(e) => setBriefTime(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  Daily brief delivered to your {profile.notification_channel === 'both' ? 'Slack & email' : profile.notification_channel}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="eod-wrap">EOD Wrap Time</Label>
                <Input id="eod-wrap" type="time" value={eodTime} onChange={(e) => setEodTime(e.target.value)} />
                <p className="text-xs text-muted-foreground">End-of-day summary with action items</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="weekly-brief-day">Weekly Brief Day</Label>
              <select
                id="weekly-brief-day"
                value={weeklyBriefDay}
                onChange={(e) => setWeeklyBriefDay(e.target.value)}
                className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 cursor-pointer"
              >
                <option value="monday">Monday</option>
                <option value="tuesday">Tuesday</option>
                <option value="wednesday">Wednesday</option>
                <option value="thursday">Thursday</option>
                <option value="friday">Friday</option>
                <option value="sunday">Sunday</option>
              </select>
              <p className="text-xs text-muted-foreground">Weekly strategic summary with commitment tracking</p>
            </div>

            <Divider />

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Show Agent Thinking</p>
                <p className="text-xs text-muted-foreground">Display reasoning steps and tool usage in the chat</p>
              </div>
              <Toggle checked={showThinking} onChange={setShowThinking} />
            </div>

            <Divider />

            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">AI Model</p>
                <p className="text-xs text-muted-foreground">
                  Choose which AI model powers your Captain. Changes take effect on the next message.
                </p>
              </div>
              <SDKToggle variant="full" />
            </div>
          </div>
        </Section>

        <div className="flex justify-end">
          <Button onClick={handleSaveProfile} disabled={savingProfile} className="cursor-pointer">
            {savingProfile ? 'Saving...' : 'Save Profile & Preferences'}
          </Button>
        </div>

        {/* ── Organization ── */}
        <Section icon={Building2} title="Organization" description="Manage your organization settings">
          <div className="space-y-6">
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

            <Divider />

            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Chief Focus</p>
                <p className="text-xs text-muted-foreground">
                  Tell the Chief what to actively optimize for, and what to keep in the background.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="focus-topics">Current Focus Topics</Label>
                  <Textarea
                    id="focus-topics"
                    value={focusTopics}
                    onChange={(e) => setFocusTopics(e.target.value)}
                    placeholder={'Crane Ventures\nKeyValue estimation\nClient delivery'}
                    className="min-h-[120px]"
                  />
                  <p className="text-xs text-muted-foreground">One topic, account, or project per line.</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="deprioritized-topics">Deprioritized Topics</Label>
                  <Textarea
                    id="deprioritized-topics"
                    value={deprioritizedTopics}
                    onChange={(e) => setDeprioritizedTopics(e.target.value)}
                    placeholder={'Axari\nAI Spotlight\nInternal product'}
                    className="min-h-[120px]"
                  />
                  <p className="text-xs text-muted-foreground">These signals are muted unless they are urgent or directly block focused work.</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="focus-instructions">Additional Guidance</Label>
                <Textarea
                  id="focus-instructions"
                  value={focusInstructions}
                  onChange={(e) => setFocusInstructions(e.target.value)}
                  placeholder="I am no longer actively working on Axari. Keep it in the background unless it becomes urgent or blocks Crane work."
                  className="min-h-[100px]"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveOrg} disabled={savingOrg} variant="outline" className="cursor-pointer">
                {savingOrg ? 'Saving...' : 'Save Organization'}
              </Button>
            </div>
          </div>
        </Section>

        {/* ── Connected Integrations ── */}
        <Section icon={Plug} title="Connected Integrations" description="Quick overview of your connected tools">
          <ConnectedIntegrationsSummary />
        </Section>

        {/* ── Meeting Bot ── */}
        {botConfigLoaded && (
          <Section
            icon={Video}
            title="Meeting Bot"
            description="Automatic meeting recording & transcription"
            trailing={<Toggle checked={botEnabled} onChange={setBotEnabled} />}
          >
            {botEnabled ? (
              <div className="space-y-6">
                {/* Join Mode */}
                <div className="space-y-3">
                  <Label>Join Mode</Label>
                  <div className="grid gap-2">
                    {([
                      { value: 'all' as const, label: 'All Meetings', description: 'Automatically join all calendar meetings with a video link' },
                      { value: 'min_attendees' as const, label: 'Minimum Attendees', description: 'Only join meetings with enough participants' },
                      { value: 'labeled' as const, label: 'Labeled Only', description: 'Only join meetings whose title includes a label' },
                      { value: 'manual' as const, label: 'Manual', description: 'Never auto-join — you trigger recording manually' },
                    ]).map((mode) => (
                      <RadioOption
                        key={mode.value}
                        selected={joinMode === mode.value}
                        onClick={() => setJoinMode(mode.value)}
                        label={mode.label}
                        description={mode.description}
                      />
                    ))}
                  </div>
                </div>

                {/* Conditional fields */}
                {joinMode === 'min_attendees' && (
                  <div className="space-y-2">
                    <Label htmlFor="min-attendees">Minimum Attendees</Label>
                    <Input
                      id="min-attendees"
                      type="number"
                      min={2}
                      max={50}
                      value={minAttendees}
                      onChange={(e) => setMinAttendees(parseInt(e.target.value) || 2)}
                      className="max-w-[120px]"
                    />
                    <p className="text-xs text-muted-foreground">Bot only joins meetings with at least this many attendees</p>
                  </div>
                )}

                {joinMode === 'labeled' && (
                  <div className="space-y-2">
                    <Label htmlFor="record-label">Record Label</Label>
                    <Input
                      id="record-label"
                      value={recordLabel}
                      onChange={(e) => setRecordLabel(e.target.value)}
                      placeholder="[record]"
                      className="max-w-xs"
                    />
                    <p className="text-xs text-muted-foreground">Add this text to a meeting title to trigger recording</p>
                  </div>
                )}

                <Divider />

                {/* Transcription Engine */}
                <div className="space-y-2">
                  <Label htmlFor="transcription-engine">Transcription Engine</Label>
                  <select
                    id="transcription-engine"
                    value={transcriptionEngine}
                    onChange={(e) => setTranscriptionEngine(e.target.value as TranscriptionEngine)}
                    className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 cursor-pointer"
                  >
                    <option value="groq_whisper">Groq Whisper (Free, 240 hrs/mo)</option>
                    <option value="deepgram">Deepgram</option>
                    <option value="whisperx">WhisperX (Local, CPU)</option>
                  </select>
                  <p className="text-xs text-muted-foreground">Audio-to-text engine. Groq Whisper is free and recommended.</p>
                </div>

                <Divider />

                {/* Auto-summarize */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Auto-Summarize</p>
                    <p className="text-xs text-muted-foreground">Generate AI summaries, action items &amp; decisions after transcription</p>
                  </div>
                  <Toggle checked={autoSummarize} onChange={setAutoSummarize} />
                </div>

                <Divider />

                {/* Notifications */}
                <div className="space-y-3">
                  <Label>Post-Meeting Notifications</Label>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm">Slack Notification</p>
                        <p className="text-xs text-muted-foreground">Send meeting summary to your Slack DM</p>
                      </div>
                      <Toggle checked={notifySlack} onChange={setNotifySlack} />
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm">Email Notification</p>
                        <p className="text-xs text-muted-foreground">Send meeting summary via email</p>
                      </div>
                      <Toggle checked={notifyEmail} onChange={setNotifyEmail} />
                    </div>
                  </div>
                </div>

                <Divider />

                {/* Blocklist */}
                <div className="space-y-2">
                  <Label htmlFor="blocklist">Blocklist Patterns</Label>
                  <textarea
                    id="blocklist"
                    value={blocklistPatterns}
                    onChange={(e) => setBlocklistPatterns(e.target.value)}
                    rows={3}
                    placeholder={"1:1 with*\nStandup\nAll Hands"}
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm
                               placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2
                               focus-visible:ring-primary/30 resize-none"
                  />
                  <p className="text-xs text-muted-foreground">
                    One pattern per line. Meetings matching these patterns will be skipped. Use * as wildcard.
                  </p>
                </div>

                <div className="flex justify-end">
                  <Button onClick={handleSaveBotConfig} disabled={savingBot} className="cursor-pointer">
                    {savingBot ? 'Saving...' : 'Save Bot Settings'}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-2">
                Enable the meeting bot to configure automatic recording and transcription settings.
              </p>
            )}
          </Section>
        )}

        {/* ── Danger Zone ── */}
        <section className="rounded-xl border border-destructive/30 bg-card">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-destructive/20">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-destructive">Danger Zone</h2>
              <p className="text-xs text-muted-foreground">Irreversible actions that affect your account</p>
            </div>
          </div>
          <div className="px-5 py-5">
            <div className="flex items-center justify-between rounded-lg border border-destructive/20 p-4">
              <div>
                <p className="text-sm font-medium">Sign Out</p>
                <p className="text-xs text-muted-foreground">Sign out of your account on this device</p>
              </div>
              <Dialog open={showSignOutDialog} onOpenChange={setShowSignOutDialog}>
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="cursor-pointer">
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
                    <Button variant="outline" onClick={() => setShowSignOutDialog(false)} className="cursor-pointer">
                      Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleSignOut} className="cursor-pointer">
                      Sign Out
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

/* ─── Connected Integrations Summary ──────────────────────────────── */

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
          <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/50" />
        ))}
      </div>
    )
  }

  if (integrations.length === 0) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <p className="text-sm text-muted-foreground mb-1">No integrations connected yet</p>
        <Link href="/integrations" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          Connect your first integration
          <ChevronRight className="h-3 w-3" />
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {integrations.map((integration) => (
        <div
          key={integration.key}
          className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5 transition-colors duration-200 hover:bg-muted/30"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
              {integration.name[0]}
            </div>
            <div>
              <p className="text-sm font-medium">{integration.name}</p>
              {integration.connected_email && (
                <p className="text-xs text-muted-foreground">{integration.connected_email}</p>
              )}
            </div>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${
              integration.health_status === 'healthy'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400'
                : integration.health_status === 'unhealthy'
                ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
                : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${
              integration.health_status === 'healthy' ? 'bg-emerald-500'
                : integration.health_status === 'unhealthy' ? 'bg-red-500' : 'bg-amber-500'
            }`} />
            {integration.health_status}
          </span>
        </div>
      ))}
      <div className="pt-2">
        <Link href="/integrations" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          Manage all integrations
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  )
}
