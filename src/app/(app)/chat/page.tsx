'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChatInterface } from '@/components/chat/chat-interface'
import { ConversationSidebar } from '@/components/chat/conversation-sidebar'

function ChatPageInner() {
  const searchParams = useSearchParams()
  const initialPrompt = searchParams.get('prompt') || undefined

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <ConversationSidebar />
      <div className="flex-1 min-h-0">
        <ChatInterface initialPrompt={initialPrompt} />
      </div>
    </div>
  )
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatPageInner />
    </Suspense>
  )
}
