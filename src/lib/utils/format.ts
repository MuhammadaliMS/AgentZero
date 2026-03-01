import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns'

export function formatRelativeDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date

  if (isToday(d)) {
    return `Today at ${format(d, 'h:mm a')}`
  }
  if (isYesterday(d)) {
    return `Yesterday at ${format(d, 'h:mm a')}`
  }
  return formatDistanceToNow(d, { addSuffix: true })
}

export function formatDate(date: string | Date, fmt: string = 'MMM d, yyyy'): string {
  return format(typeof date === 'string' ? new Date(date) : date, fmt)
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.slice(0, length) + '...'
}
