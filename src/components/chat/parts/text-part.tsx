'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { TextPart as TextPartType } from '@/types/chat'

interface TextPartProps {
  part: TextPartType
  isStreaming?: boolean
}

// ─── Custom Markdown Components ─────────────────────────────────────────

const markdownComponents: Components = {
  // ── Tables ────────────────────────────────────────────────────────────
  table: ({ children, ...props }) => (
    <div className="my-3 overflow-x-auto rounded-lg border">
      <table className="min-w-full text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-muted/50 text-left" {...props}>
      {children}
    </thead>
  ),
  th: ({ children, ...props }) => (
    <th className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border-b px-3 py-2" {...props}>
      {children}
    </td>
  ),
  tr: ({ children, ...props }) => (
    <tr className="transition-colors hover:bg-muted/30" {...props}>
      {children}
    </tr>
  ),

  // ── Code blocks ───────────────────────────────────────────────────────
  pre: ({ children, ...props }) => (
    <pre
      className="my-3 overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed"
      {...props}
    >
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }) => {
    // Inline code (no language class) vs block code (rendered inside <pre>)
    const isBlock = className?.startsWith('language-')
    if (isBlock) {
      return (
        <code className={`${className} font-mono`} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code
        className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground"
        {...props}
      >
        {children}
      </code>
    )
  },

  // ── Links ─────────────────────────────────────────────────────────────
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      {...props}
    >
      {children}
    </a>
  ),

  // ── Lists — ensure proper spacing ─────────────────────────────────────
  ul: ({ children, ...props }) => (
    <ul className="my-2 ml-4 list-disc space-y-1 [&>li]:pl-1" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="my-2 ml-4 list-decimal space-y-1 [&>li]:pl-1" {...props}>
      {children}
    </ol>
  ),

  // ── Paragraphs — tighter spacing ──────────────────────────────────────
  p: ({ children, ...props }) => (
    <p className="my-1.5 leading-relaxed" {...props}>
      {children}
    </p>
  ),

  // ── Headings ──────────────────────────────────────────────────────────
  h1: ({ children, ...props }) => (
    <h1 className="mt-4 mb-2 text-lg font-bold" {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mt-3 mb-1.5 text-base font-semibold" {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mt-2.5 mb-1 text-sm font-semibold" {...props}>{children}</h3>
  ),

  // ── Blockquote ────────────────────────────────────────────────────────
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-2 border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground"
      {...props}
    >
      {children}
    </blockquote>
  ),

  // ── Horizontal rule ───────────────────────────────────────────────────
  hr: (props) => <hr className="my-4 border-border" {...props} />,
}

// ─── Component ──────────────────────────────────────────────────────────

export function TextPartBlock({ part, isStreaming }: TextPartProps) {
  if (!part.content && !isStreaming) return null

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {part.content || ''}
      </ReactMarkdown>
      {isStreaming && !part.content && (
        <span className="inline-block h-4 w-1 animate-pulse bg-foreground/50" />
      )}
    </div>
  )
}
