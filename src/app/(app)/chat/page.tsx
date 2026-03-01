'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChatInterface } from '@/components/chat/chat-interface'
import { ConversationSidebar } from '@/components/chat/conversation-sidebar'

function ChatPageInner() {
  const searchParams = useSearchParams()
  const initialPrompt = searchParams.get('prompt') || undefined

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <ConversationSidebar />
      <div className="flex-1">
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
