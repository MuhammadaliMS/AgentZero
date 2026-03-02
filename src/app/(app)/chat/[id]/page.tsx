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
    <div className="flex h-full min-h-0 overflow-hidden">
      <ConversationSidebar />
      <div className="flex-1 min-h-0">
        <ChatInterface conversationId={id} />
      </div>
    </div>
  )
}
