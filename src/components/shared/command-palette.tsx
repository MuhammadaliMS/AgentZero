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
import {
  MessageSquare,
  BrainCircuit,
  Layers,
  Settings,
  Clock,
  Shield,
  AlertTriangle,
  CheckCircle,
  Calendar,
  Mail,
} from 'lucide-react'

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
      // Cmd+Shift+D → intelligence workspace
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'd') {
        e.preventDefault()
        router.push('/intelligence')
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
      icon: <MessageSquare className="h-4 w-4" />,
      action: () => navigate('/chat'),
    },
    {
      id: 'intelligence',
      label: 'Intelligence',
      group: 'Navigation',
      keywords: ['dashboard', 'overview', 'actions', 'home', 'vault', 'workspace'],
      icon: <BrainCircuit className="h-4 w-4" />,
      action: () => navigate('/intelligence'),
    },
    {
      id: 'integrations',
      label: 'Integrations',
      group: 'Navigation',
      keywords: ['connect', 'tools', 'apps', 'slack', 'gmail'],
      icon: <Layers className="h-4 w-4" />,
      action: () => navigate('/integrations'),
    },
    {
      id: 'settings',
      label: 'Settings',
      group: 'Navigation',
      shortcut: '\u2318,',
      keywords: ['profile', 'preferences', 'account', 'organization'],
      icon: <Settings className="h-4 w-4" />,
      action: () => navigate('/settings'),
    },

    // Quick Actions — pre-fill the chat with a prompt
    {
      id: 'morning-brief',
      label: "What's on my plate today?",
      group: 'Quick Actions',
      keywords: ['brief', 'morning', 'today', 'schedule', 'agenda'],
      icon: <Clock className="h-4 w-4" />,
      action: () => askAgent("What's on my plate today? Give me a morning brief."),
    },
    {
      id: 'delivery',
      label: 'Show my delivery status',
      group: 'Quick Actions',
      keywords: ['delivery', 'features', 'roadmap', 'health', 'status'],
      icon: <Shield className="h-4 w-4" />,
      action: () => askAgent('Show my delivery status. What needs attention?'),
    },
    {
      id: 'commitments',
      label: 'Any commitments at risk?',
      group: 'Quick Actions',
      keywords: ['deadlines', 'overdue', 'tracking', 'deliverables'],
      icon: <AlertTriangle className="h-4 w-4" />,
      action: () => askAgent('Are there any commitments at risk or overdue? Give me a status summary.'),
    },
    {
      id: 'pending-actions',
      label: 'Show pending actions',
      group: 'Quick Actions',
      keywords: ['approvals', 'pending', 'todo', 'action items'],
      icon: <CheckCircle className="h-4 w-4" />,
      action: () => askAgent('What actions need my attention? Show me all pending items.'),
    },
    {
      id: 'week-ahead',
      label: "Prep me for the week ahead",
      group: 'Quick Actions',
      keywords: ['week', 'upcoming', 'calendar', 'prepare', 'plan'],
      icon: <Calendar className="h-4 w-4" />,
      action: () => askAgent('Prep me for the week ahead. What meetings, deadlines, and commitments should I be aware of?'),
    },
    {
      id: 'draft-email',
      label: 'Help me draft an email',
      group: 'Quick Actions',
      keywords: ['email', 'write', 'compose', 'send', 'outlook', 'gmail'],
      icon: <Mail className="h-4 w-4" />,
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
