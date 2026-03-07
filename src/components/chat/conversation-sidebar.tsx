'use client'

import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useConversations } from '@/hooks/use-conversations'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatRelativeDate } from '@/lib/utils/format'
import { cn } from '@/lib/utils'
import {
  Plus,
  Search,
  X,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
  CalendarCheck,
  BarChart3,
  Mail,
  ShieldCheck,
  Presentation,
  MessagesSquare,
} from 'lucide-react'

/** Pick a contextual icon based on conversation title keywords */
function getConversationIcon(title: string) {
  const t = title.toLowerCase()
  if (t.includes('meeting') || t.includes('prep')) return Presentation
  if (t.includes('delivery') || t.includes('status')) return BarChart3
  if (t.includes('email') || t.includes('mail')) return Mail
  if (t.includes('compliance') || t.includes('security') || t.includes('risk')) return ShieldCheck
  if (t.includes('calendar') || t.includes('schedule') || t.includes('plate')) return CalendarCheck
  if (t.includes('slack') || t.includes('message')) return MessagesSquare
  return MessageSquare
}

export function ConversationSidebar() {
  const {
    groupedConversations,
    loading,
    searchQuery,
    setSearchQuery,
    deleteConversation,
    renameConversation,
    refresh,
  } = useConversations()
  const pathname = usePathname()
  const router = useRouter()

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Delete confirmation state
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deletingTitle, setDeletingTitle] = useState('')

  // Focus rename input when it opens
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  function handleStartRename(id: string, currentTitle: string) {
    setRenamingId(id)
    setRenameValue(currentTitle)
  }

  async function handleFinishRename() {
    if (renamingId && renameValue.trim()) {
      await renameConversation(renamingId, renameValue)
    }
    setRenamingId(null)
    setRenameValue('')
  }

  function handleRenameKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleFinishRename()
    } else if (e.key === 'Escape') {
      setRenamingId(null)
      setRenameValue('')
    }
  }

  async function handleConfirmDelete() {
    if (deletingId) {
      await deleteConversation(deletingId)
      if (pathname === `/chat/${deletingId}`) {
        router.push('/chat')
      }
    }
    setDeletingId(null)
    setDeletingTitle('')
  }

  // Refresh conversations when navigating between chat pages
  useEffect(() => {
    refresh()
  }, [pathname, refresh])

  const totalCount = groupedConversations.reduce((acc, g) => acc + g.conversations.length, 0)

  return (
    <div className="hidden md:flex h-full w-72 flex-col border-r bg-muted/20">
      {/* Header */}
      <div className="flex h-13 items-center justify-between border-b px-4">
        <span className="text-sm font-semibold tracking-tight">Conversations</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          asChild
        >
          <Link href="/chat">
            <Plus className="h-3.5 w-3.5" />
            New
          </Link>
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="h-8 pl-8 text-xs bg-background/60 border-transparent focus:border-border"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Conversation list */}
      <ScrollArea className="flex-1">
        <div className="px-2 pb-2">
          {loading && (
            <div className="space-y-1 px-1 pt-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-lg px-2 py-2.5">
                  <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-muted" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted" />
                    <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && totalCount === 0 && !searchQuery && (
            <div className="px-3 py-10 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                <MessageSquare className="h-5 w-5 text-primary" />
              </div>
              <p className="text-sm font-medium text-foreground/80">No conversations yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Start a new one to get going.</p>
            </div>
          )}

          {!loading && totalCount === 0 && searchQuery && (
            <div className="px-3 py-10 text-center">
              <p className="text-xs text-muted-foreground">No matches for &quot;{searchQuery}&quot;</p>
            </div>
          )}

          {groupedConversations.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="sticky top-0 z-10 bg-muted/20 backdrop-blur-sm px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  {group.label}
                </span>
              </div>
              <div className="space-y-0.5">
                {group.conversations.map((conv) => {
                  const isActive = pathname === `/chat/${conv.id}`
                  const title = conv.title || 'New conversation'
                  const date = conv.updated_at || conv.created_at
                  const Icon = getConversationIcon(title)

                  // If renaming this conversation, show input
                  if (renamingId === conv.id) {
                    return (
                      <div key={conv.id} className="px-1">
                        <Input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={handleRenameKeyDown}
                          onBlur={handleFinishRename}
                          className="h-8 text-xs"
                        />
                      </div>
                    )
                  }

                  return (
                    <div
                      key={conv.id}
                      className={cn(
                        'group relative flex items-center gap-2.5 rounded-lg px-2 py-2 transition-all',
                        isActive
                          ? 'bg-accent shadow-sm'
                          : 'hover:bg-accent/50'
                      )}
                    >
                      {/* Icon */}
                      <div
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                          isActive
                            ? 'bg-primary/15 text-primary'
                            : 'bg-muted/80 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary/70'
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>

                      <Link
                        href={`/chat/${conv.id}`}
                        className="flex flex-1 flex-col min-w-0 gap-0.5"
                      >
                        <span
                          className={cn(
                            'truncate text-[13px] leading-tight',
                            isActive ? 'font-semibold text-foreground' : 'font-medium text-foreground/80'
                          )}
                        >
                          {title}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70">
                          {formatRelativeDate(date)}
                        </span>
                      </Link>

                      {/* Context menu button */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className={cn(
                              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-all hover:bg-muted-foreground/10 group-hover:opacity-100',
                              isActive && 'opacity-60'
                            )}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onClick={() => handleStartRename(conv.id, title)}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              setDeletingId(conv.id)
                              setDeletingTitle(title)
                            }}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete conversation</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{deletingTitle}&quot;? This conversation will be archived and hidden from your sidebar.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
