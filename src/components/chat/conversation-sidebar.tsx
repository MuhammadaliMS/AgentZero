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
    <div className="hidden md:flex h-full w-64 flex-col border-r border-border bg-sidebar">
      {/* Header */}
      <div className="flex h-12 items-center justify-between px-4">
        <span className="text-[13px] font-medium text-muted-foreground">Conversations</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          asChild
        >
          <Link href="/chat">
            <Plus className="h-3.5 w-3.5" />
            New
          </Link>
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 py-2.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="h-8 pl-8 text-xs bg-background/60 border-border focus:border-foreground/20 focus:ring-0 rounded-md transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Conversation list */}
      <ScrollArea className="flex-1">
        <div className="px-2 pb-2">
          {/* Loading skeleton */}
          {loading && (
            <div className="space-y-1 px-1 pt-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-lg px-2 py-2.5">
                  <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-muted/60" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted/60" />
                    <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted/40" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty state - no conversations */}
          {!loading && totalCount === 0 && !searchQuery && (
            <div className="px-3 py-12 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
                <MessageSquare className="h-5 w-5 text-primary" />
              </div>
              <p className="text-sm font-medium text-foreground/80">No conversations yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Start a new one to get going.
              </p>
            </div>
          )}

          {/* Empty state - no search results */}
          {!loading && totalCount === 0 && searchQuery && (
            <div className="px-3 py-12 text-center">
              <Search className="mx-auto mb-2 h-5 w-5 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">
                No matches for &quot;{searchQuery}&quot;
              </p>
            </div>
          )}

          {/* Grouped conversations */}
          {groupedConversations.map((group) => (
            <div key={group.label} className="mb-1">
              {/* Sticky date header */}
              <div className="sticky top-0 z-10 bg-muted/10 backdrop-blur-sm px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                  {group.label}
                </span>
              </div>

              <div className="space-y-0.5">
                {group.conversations.map((conv) => {
                  const isActive = pathname === `/chat/${conv.id}`
                  const title = conv.title || 'New conversation'
                  const date = conv.updated_at || conv.created_at
                  const Icon = getConversationIcon(title)

                  // Rename mode
                  if (renamingId === conv.id) {
                    return (
                      <div key={conv.id} className="px-1">
                        <Input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={handleRenameKeyDown}
                          onBlur={handleFinishRename}
                          className="h-8 text-xs rounded-lg"
                        />
                      </div>
                    )
                  }

                  return (
                    <div
                      key={conv.id}
                      className={cn(
                        'group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-100',
                        isActive
                          ? 'bg-accent text-foreground'
                          : 'hover:bg-accent/60'
                      )}
                    >
                      {/* Contextual icon */}
                      <div
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center',
                          isActive
                            ? 'text-foreground/70'
                            : 'text-muted-foreground/60'
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>

                      {/* Title + date link */}
                      <Link
                        href={`/chat/${conv.id}`}
                        className="flex flex-1 flex-col min-w-0 gap-0.5"
                      >
                        <span
                          className={cn(
                            'truncate text-[13px] leading-tight',
                            isActive ? 'font-medium text-foreground' : 'text-foreground/75'
                          )}
                        >
                          {title}
                        </span>
                        <span className="text-[11px] text-muted-foreground/50">
                          {formatRelativeDate(date)}
                        </span>
                      </Link>

                      {/* Context menu */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className={cn(
                              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-all hover:bg-muted-foreground/10 group-hover:opacity-100 cursor-pointer',
                              isActive && 'opacity-60'
                            )}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onClick={() => handleStartRename(conv.id, title)} className="cursor-pointer">
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              setDeletingId(conv.id)
                              setDeletingTitle(title)
                            }}
                            className="text-destructive focus:text-destructive cursor-pointer"
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
            <Button variant="outline" onClick={() => setDeletingId(null)} className="cursor-pointer">
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} className="cursor-pointer">
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
