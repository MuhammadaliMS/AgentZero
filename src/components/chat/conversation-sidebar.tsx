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
      // If we were viewing this conversation, redirect to /chat
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
    <div className="hidden md:flex h-full w-64 flex-col border-r bg-muted/30">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">Conversations</span>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" asChild>
          <Link href="/chat">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New
          </Link>
        </Button>
      </div>

      {/* Search */}
      <div className="px-2 py-2">
        <div className="relative">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="h-8 pl-8 text-xs bg-background"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Conversation list */}
      <ScrollArea className="flex-1">
        <div className="px-2 pb-2">
          {loading && (
            <div className="space-y-2 p-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          )}

          {!loading && totalCount === 0 && !searchQuery && (
            <div className="px-3 py-8 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p className="text-xs text-muted-foreground">No conversations yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">Start a new one to get going.</p>
            </div>
          )}

          {!loading && totalCount === 0 && searchQuery && (
            <div className="px-3 py-8 text-center">
              <p className="text-xs text-muted-foreground">No matches for &quot;{searchQuery}&quot;</p>
            </div>
          )}

          {groupedConversations.map((group) => (
            <div key={group.label} className="mb-2">
              <div className="sticky top-0 bg-muted/30 px-3 py-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </span>
              </div>
              <div className="space-y-0.5">
                {group.conversations.map((conv) => {
                  const isActive = pathname === `/chat/${conv.id}`
                  const title = conv.title || 'New conversation'
                  const date = conv.updated_at || conv.created_at

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
                        'group relative flex items-center rounded-md transition-colors hover:bg-muted',
                        isActive && 'bg-muted'
                      )}
                    >
                      <Link
                        href={`/chat/${conv.id}`}
                        className="flex flex-1 flex-col min-w-0 px-3 py-2"
                      >
                        <span className="truncate text-sm font-medium text-foreground/90">
                          {title}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatRelativeDate(date)}
                        </span>
                      </Link>

                      {/* Context menu button */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className={cn(
                              'absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted-foreground/10 group-hover:opacity-100',
                              isActive && 'opacity-100'
                            )}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-muted-foreground">
                              <circle cx="12" cy="5" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="12" cy="19" r="2" />
                            </svg>
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onClick={() => handleStartRename(conv.id, title)}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2">
                              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                            </svg>
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
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
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
