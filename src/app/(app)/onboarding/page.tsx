'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { IntegrationCatalog } from '@/components/integrations/integration-catalog'
import { useIntegrations } from '@/hooks/use-integrations'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Zap, Plug } from 'lucide-react'

interface OnboardingMessage {
  role: 'assistant'
  content: string
}

export default function OnboardingPage() {
  const router = useRouter()
  const supabase = createClient()
  const { integrations, loading, connectedKeys, refresh } = useIntegrations()
  const [messages, setMessages] = useState<OnboardingMessage[]>([])
  const [completing, setCompleting] = useState(false)

  // Initial greeting
  useEffect(() => {
    setMessages([
      {
        role: 'assistant',
        content:
          "Welcome! I'm your Captain - think of me as your AI-powered executive aide. I'll help you stay on top of commitments, compliance, and communications.\n\nLet's start by connecting your tools. I'd recommend starting with your **email** and **Slack** so I can immediately begin helping you.",
      },
    ])
  }, [])

  // React to new connections
  useEffect(() => {
    if (connectedKeys.length === 0) return

    const newMessages: OnboardingMessage[] = []

    if (connectedKeys.includes('slack') && !messages.some(m => m.content.includes('Slack DMs'))) {
      newMessages.push({
        role: 'assistant',
        content:
          "Slack connected! I'll send you morning briefs and urgent nudges via DM. You can also message me directly in Slack anytime.",
      })
    }

    if (connectedKeys.includes('gmail') && !messages.some(m => m.content.includes('scanning your inbox'))) {
      newMessages.push({
        role: 'assistant',
        content:
          "Gmail connected! I'm now scanning your inbox for items that need your attention. Once we're set up, I'll proactively surface important emails and help draft responses.",
      })
    }

    if (connectedKeys.includes('microsoft_365') && !messages.some(m => m.content.includes('Microsoft 365'))) {
      newMessages.push({
        role: 'assistant',
        content:
          "Microsoft 365 connected! I can now read your Outlook emails and calendar. I'll help you stay on top of meetings and communications.",
      })
    }

    if (connectedKeys.includes('vanta') && !messages.some(m => m.content.includes('platform health'))) {
      newMessages.push({
        role: 'assistant',
        content:
          "Vanta connected! I can now monitor your platform health. I'll track failing checks and surface issues proactively.",
      })
    }

    if (connectedKeys.includes('crowdstrike') && !messages.some(m => m.content.includes('endpoint security'))) {
      newMessages.push({
        role: 'assistant',
        content:
          "CrowdStrike connected! I'll keep an eye on your endpoint security posture and flag any critical detections.",
      })
    }

    if (connectedKeys.includes('jira') && !messages.some(m => m.content.includes('Jira'))) {
      newMessages.push({
        role: 'assistant',
        content:
          "Jira connected! I can now track security-related issues and project progress across your boards.",
      })
    }

    if (connectedKeys.includes('github') && !messages.some(m => m.content.includes('GitHub'))) {
      newMessages.push({
        role: 'assistant',
        content:
          "GitHub connected! I'll monitor security advisories and important repository activity.",
      })
    }

    if (connectedKeys.includes('notion') && !messages.some(m => m.content.includes('Notion'))) {
      newMessages.push({
        role: 'assistant',
        content:
          "Notion connected! I can now access your knowledge base and documentation.",
      })
    }

    if (newMessages.length > 0) {
      setMessages(prev => [...prev, ...newMessages])
    }
  }, [connectedKeys, messages])

  async function handleComplete() {
    setCompleting(true)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    // Mark onboarding as complete
    await supabase
      .from('onboarding_state')
      .update({ is_complete: true })
      .eq('user_id', user.id)

    // Update profile onboarded_at
    await supabase
      .from('profiles')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', user.id)

    router.push('/chat')
    router.refresh()
  }

  return (
    <div className="flex h-full">
      {/* Left: Chat messages */}
      <div className="flex flex-1 flex-col border-r">
        <div className="border-b p-4 flex items-center gap-3">
          <div className="bg-gradient-brand flex h-9 w-9 items-center justify-center rounded-lg">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Captain</h2>
            <p className="text-sm text-muted-foreground">Setting up your workspace</p>
          </div>
        </div>
        <ScrollArea className="flex-1 p-4">
          <div className="space-y-4 max-w-2xl">
            {messages.map((message, i) => (
              <Card key={i} className="bg-muted/50 shadow-md border-0">
                <CardContent className="p-4">
                  <div className="flex gap-3">
                    <div className="bg-gradient-brand flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white">
                      <Zap className="h-4 w-4" />
                    </div>
                    <div className="text-sm leading-relaxed whitespace-pre-wrap">
                      {message.content.split('**').map((part, j) =>
                        j % 2 === 1 ? <strong key={j}>{part}</strong> : part
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
        <div className="border-t p-4">
          <Button
            onClick={handleComplete}
            disabled={completing}
            className="w-full"
            size="lg"
          >
            {completing ? 'Setting up...' : connectedKeys.length > 0
              ? `Continue to Dashboard (${connectedKeys.length} connected)`
              : 'Skip for now'}
          </Button>
        </div>
      </div>

      {/* Right: Integration grid */}
      <div className="w-[420px] shrink-0">
        <div className="border-b p-4 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Plug className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Connect Your Tools</h2>
            <p className="text-sm text-muted-foreground">
              {connectedKeys.length} of {integrations.length} connected
            </p>
          </div>
        </div>
        <ScrollArea className="h-[calc(100vh-8rem)]">
          <div className="p-4">
            <IntegrationCatalog
              integrations={integrations}
              loading={loading}
              onConnected={refresh}
            />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
