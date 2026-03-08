'use client'

import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'
import { Sun, Moon, CalendarRange, FileText } from 'lucide-react'
import type { Database } from '@/types/database'

type Brief = Database['public']['Tables']['briefs']['Row']

interface BriefCardProps {
  brief: Brief
}

const typeConfig: Record<string, { label: string; icon: React.ElementType; accent: string; bg: string }> = {
  morning: { label: 'Morning Brief', icon: Sun, accent: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/30' },
  eod: { label: 'EOD Wrap', icon: Moon, accent: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-50 dark:bg-indigo-950/30' },
  weekly: { label: 'Weekly Summary', icon: CalendarRange, accent: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
  ad_hoc: { label: 'Brief', icon: FileText, accent: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/30' },
}

export function BriefCard({ brief }: BriefCardProps) {
  const content = brief.content as { text?: string } | null
  const text = content?.text || ''
  const dateStr = brief.sent_at || brief.created_at
  const cfg = typeConfig[brief.type] || typeConfig.ad_hoc
  const Icon = cfg.icon

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden transition-all duration-200 hover:shadow-md hover:border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
        <div className="flex items-center gap-2.5">
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${cfg.bg}`}>
            <Icon className={`h-4 w-4 ${cfg.accent}`} />
          </div>
          <div>
            <p className="text-sm font-medium">{cfg.label}</p>
            <p className="text-[11px] text-muted-foreground">
              {format(new Date(dateStr), 'MMM d, yyyy h:mm a')}
            </p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${
          brief.status === 'read'
            ? 'bg-muted text-muted-foreground'
            : 'bg-primary/10 text-primary'
        }`}>
          <span className={`h-1.5 w-1.5 rounded-full ${
            brief.status === 'read' ? 'bg-muted-foreground/40' : 'bg-primary'
          }`} />
          {brief.status}
        </span>
      </div>

      {/* Content */}
      <div className="px-4 py-3 relative">
        <div className="prose prose-sm dark:prose-invert max-w-none max-h-36 overflow-hidden
                        prose-p:text-[13px] prose-p:leading-relaxed prose-headings:text-sm
                        prose-ul:text-[13px] prose-li:text-[13px]">
          <ReactMarkdown>{text.slice(0, 500)}</ReactMarkdown>
        </div>
        {text.length > 500 && (
          <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
    </div>
  )
}
