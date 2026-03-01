'use client'

import { use } from 'react'
import { ChatInterface } from '@/components/chat/chat-interface'
import { ConversationSidebar } from '@/components/chat/conversation-sidebar'

export default function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <ConversationSidebar />
      <div className="flex-1">
        <ChatInterface conversationId={id} />
      </div>
    </div>
  )
}
