'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'

import type { Database, Json } from '@/types/database'

type Brief = Database['public']['Tables']['briefs']['Row']

interface BriefCardProps {
  brief: Brief
}

const typeLabels: Record<string, string> = {
  morning: 'Morning Brief',
  eod: 'EOD Wrap',
  weekly: 'Weekly Summary',
  ad_hoc: 'Brief',
}

export function BriefCard({ brief }: BriefCardProps) {
  const content = brief.content as { text?: string } | null
  const text = content?.text || ''
  const dateStr = brief.sent_at || brief.created_at

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-sm font-medium">
              {typeLabels[brief.type] || brief.title}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {format(new Date(dateStr), 'MMM d, yyyy h:mm a')}
            </p>
          </div>
          <Badge variant={brief.status === 'read' ? 'secondary' : 'default'}>
            {brief.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="prose prose-sm dark:prose-invert max-w-none max-h-40 overflow-hidden relative">
          <ReactMarkdown>{text.slice(0, 500)}</ReactMarkdown>
          {text.length > 500 && (
            <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-background to-transparent" />
          )}
        </div>
      </CardContent>
    </Card>
  )
}
