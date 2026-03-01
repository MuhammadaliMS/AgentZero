'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'

interface CommandAction {
  id: string
  label: string
  icon?: React.ReactNode
  shortcut?: string
  action: () => void
  group: string
  keywords?: string[]
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  // Listen for keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+K / Ctrl+K → toggle command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
      // Cmd+, → settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        router.push('/settings')
      }
      // Cmd+N → new conversation
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        router.push('/chat')
      }
      // Cmd+Shift+D → command center (dashboard)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'd') {
        e.preventDefault()
        router.push('/command-center')
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [router])

  const navigate = useCallback(
    (path: string) => {
      setOpen(false)
      router.push(path)
    },
    [router]
  )

  // Navigate to /chat with a pre-filled prompt via URL query param
  const askAgent = useCallback(
    (prompt: string) => {
      setOpen(false)
      router.push(`/chat?prompt=${encodeURIComponent(prompt)}`)
    },
    [router]
  )

  const actions: CommandAction[] = [
    // Navigation
    {
      id: 'new-chat',
      label: 'New Conversation',
      group: 'Navigation',
      shortcut: '\u2318N',
      keywords: ['chat', 'message', 'talk'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
      action: () => navigate('/chat'),
    },
    {
      id: 'command-center',
      label: 'Command Center',
      group: 'Navigation',
      keywords: ['dashboard', 'overview', 'actions', 'home'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      ),
      action: () => navigate('/command-center'),
    },
    {
      id: 'integrations',
      label: 'Integrations',
      group: 'Navigation',
      keywords: ['connect', 'tools', 'apps', 'slack', 'gmail'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
      action: () => navigate('/integrations'),
    },
    {
      id: 'settings',
      label: 'Settings',
      group: 'Navigation',
      shortcut: '\u2318,',
      keywords: ['profile', 'preferences', 'account', 'organization'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      ),
      action: () => navigate('/settings'),
    },

    // Quick Actions — pre-fill the chat with a prompt
    {
      id: 'morning-brief',
      label: "What's on my plate today?",
      group: 'Quick Actions',
      keywords: ['brief', 'morning', 'today', 'schedule', 'agenda'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      ),
      action: () => askAgent("What's on my plate today? Give me a morning brief."),
    },
    {
      id: 'compliance',
      label: 'Show my compliance posture',
      group: 'Quick Actions',
      keywords: ['vanta', 'soc2', 'controls', 'audit', 'security'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
      action: () => askAgent('Show my compliance posture. What controls need attention?'),
    },
    {
      id: 'commitments',
      label: 'Any commitments at risk?',
      group: 'Quick Actions',
      keywords: ['deadlines', 'overdue', 'tracking', 'deliverables'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      ),
      action: () => askAgent('Are there any commitments at risk or overdue? Give me a status summary.'),
    },
    {
      id: 'pending-actions',
      label: 'Show pending actions',
      group: 'Quick Actions',
      keywords: ['approvals', 'pending', 'todo', 'action items'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      ),
      action: () => askAgent('What actions need my attention? Show me all pending items.'),
    },
    {
      id: 'week-ahead',
      label: "Prep me for the week ahead",
      group: 'Quick Actions',
      keywords: ['week', 'upcoming', 'calendar', 'prepare', 'plan'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      ),
      action: () => askAgent('Prep me for the week ahead. What meetings, deadlines, and commitments should I be aware of?'),
    },
    {
      id: 'draft-email',
      label: 'Help me draft an email',
      group: 'Quick Actions',
      keywords: ['email', 'write', 'compose', 'send', 'outlook', 'gmail'],
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      ),
      action: () => askAgent('I need help drafting an email. Let me describe what I need.'),
    },
  ]

  // Group actions
  const groups = new Map<string, CommandAction[]>()
  for (const action of actions) {
    const existing = groups.get(action.group) || []
    existing.push(action)
    groups.set(action.group, existing)
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {[...groups.entries()].map(([group, items], idx) => (
          <div key={group}>
            {idx > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  onSelect={item.action}
                  keywords={item.keywords}
                  className="flex items-center gap-2"
                >
                  {item.icon && <span className="text-muted-foreground">{item.icon}</span>}
                  <span>{item.label}</span>
                  {item.shortcut && (
                    <span className="ml-auto text-xs text-muted-foreground">{item.shortcut}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
