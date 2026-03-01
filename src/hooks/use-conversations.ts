'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Database } from '@/types/database'

type Conversation = Database['public']['Tables']['conversations']['Row']

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const supabase = createClient()

  const fetchConversations = useCallback(async () => {
    const { data } = await supabase
      .from('conversations')
      .select('*')
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(50)

    setConversations((data || []) as Conversation[])
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchConversations()
  }, [fetchConversations])

  const deleteConversation = useCallback(async (id: string) => {
    await supabase
      .from('conversations')
      .update({ status: 'archived' })
      .eq('id', id)
    setConversations(prev => prev.filter(c => c.id !== id))
  }, [supabase])

  const renameConversation = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    await supabase
      .from('conversations')
      .update({ title: trimmed })
      .eq('id', id)
    setConversations(prev =>
      prev.map(c => (c.id === id ? { ...c, title: trimmed } : c))
    )
  }, [supabase])

  // Filter conversations by search query
  const filteredConversations = searchQuery.trim()
    ? conversations.filter(c =>
        (c.title || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : conversations

  // Group conversations by date
  const groupedConversations = groupByDate(filteredConversations)

  return {
    conversations: filteredConversations,
    groupedConversations,
    loading,
    searchQuery,
    setSearchQuery,
    refresh: fetchConversations,
    deleteConversation,
    renameConversation,
  }
}

interface ConversationGroup {
  label: string
  conversations: (Database['public']['Tables']['conversations']['Row'])[]
}

function groupByDate(conversations: Database['public']['Tables']['conversations']['Row'][]): ConversationGroup[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const lastWeek = new Date(today.getTime() - 7 * 86400000)
  const lastMonth = new Date(today.getTime() - 30 * 86400000)

  const groups: Record<string, Database['public']['Tables']['conversations']['Row'][]> = {
    'Today': [],
    'Yesterday': [],
    'This Week': [],
    'This Month': [],
    'Older': [],
  }

  for (const conv of conversations) {
    const date = new Date(conv.updated_at || conv.created_at)
    if (date >= today) {
      groups['Today'].push(conv)
    } else if (date >= yesterday) {
      groups['Yesterday'].push(conv)
    } else if (date >= lastWeek) {
      groups['This Week'].push(conv)
    } else if (date >= lastMonth) {
      groups['This Month'].push(conv)
    } else {
      groups['Older'].push(conv)
    }
  }

  return Object.entries(groups)
    .filter(([, convs]) => convs.length > 0)
    .map(([label, convs]) => ({ label, conversations: convs }))
}
