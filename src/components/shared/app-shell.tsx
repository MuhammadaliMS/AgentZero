'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { Separator } from '@/components/ui/separator'
import { CommandPalette } from '@/components/shared/command-palette'
import type { Database } from '@/types/database'
import { MessageSquare, LayoutGrid, Layers, Video, Settings, Search, LogOut, Menu, Zap } from 'lucide-react'

type Profile = Database['public']['Tables']['profiles']['Row']

const navItems = [
  {
    href: '/chat',
    label: 'Chat',
    icon: MessageSquare,
  },
  {
    href: '/command-center',
    label: 'Command Center',
    icon: LayoutGrid,
  },
  {
    href: '/integrations',
    label: 'Integrations',
    icon: Layers,
  },
  {
    href: '/meetings',
    label: 'Meetings',
    icon: Video,
  },
]

export function AppShell({
  profile,
  children,
}: {
  profile: Profile
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = createClient()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isMac, setIsMac] = useState(true)

  useEffect(() => {
    setIsMac(navigator.platform?.toLowerCase().includes('mac') ?? true)
  }, [])

  const initials = profile.full_name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="flex h-screen flex-col">
      {/* ── Top Bar ── */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b glass px-4">
        <div className="flex items-center gap-4">
          {/* Mobile hamburger */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 md:hidden">
                <Menu className="h-4.5 w-4.5" />
                <span className="sr-only">Toggle menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <div className="flex h-14 items-center border-b px-4">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary shadow-sm">
                    <Zap className="h-3.5 w-3.5 text-primary-foreground" />
                  </div>
                  <span className="text-lg font-semibold tracking-tight">Zerowing</span>
                </div>
              </div>
              <nav className="flex flex-col gap-1 p-3">
                {navItems.map(item => {
                  const Icon = item.icon
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all ${
                        pathname.startsWith(item.href)
                          ? 'bg-accent text-accent-foreground font-medium shadow-sm'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  )
                })}
                <Separator className="my-2" />
                <Link
                  href="/settings"
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all ${
                    pathname === '/settings'
                      ? 'bg-accent text-accent-foreground font-medium shadow-sm'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`}
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>
              </nav>
              <div className="absolute bottom-0 left-0 right-0 border-t p-3">
                <div className="flex items-center gap-2">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{profile.full_name}</p>
                    <p className="text-xs text-muted-foreground truncate">{profile.email}</p>
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>

          {/* Logo */}
          <Link href="/chat" className="flex items-center gap-2 group">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary shadow-sm transition-shadow">
              <Zap className="h-3.5 w-3.5 text-primary-foreground" />
            </div>
            <span className="hidden text-lg font-semibold tracking-tight sm:inline">Zerowing</span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-0.5 md:flex">
            {navItems.map(item => {
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-all ${
                    pathname.startsWith(item.href)
                      ? 'bg-accent text-accent-foreground font-medium shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2">
          {/* Command palette hint */}
          <button
            onClick={() => {
              document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', metaKey: isMac, ctrlKey: !isMac })
              )
            }}
            className="hidden items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition-all hover:bg-muted hover:shadow-sm sm:flex"
          >
            <Search className="h-3 w-3" />
            <span>Search</span>
            <kbd className="pointer-events-none rounded border bg-background px-1 font-mono text-[10px]">
              {isMac ? '\u2318' : 'Ctrl'}K
            </kbd>
          </button>

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="flex items-center gap-2 p-2">
                <div className="flex flex-col space-y-0.5">
                  <p className="text-sm font-medium">{profile.full_name}</p>
                  <p className="text-xs text-muted-foreground">{profile.email}</p>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/settings" className="flex items-center gap-2">
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/integrations" className="flex items-center gap-2">
                  <Layers className="h-3.5 w-3.5" />
                  Integrations
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut} className="text-destructive focus:text-destructive">
                <LogOut className="mr-2 h-3.5 w-3.5" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="flex-1 overflow-auto min-h-0">
        {children}
      </main>

      {/* ── Command Palette ── */}
      <CommandPalette />
    </div>
  )
}
