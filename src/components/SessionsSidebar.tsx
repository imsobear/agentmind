import { useEffect, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Activity, Circle } from 'lucide-react'
import { api, subscribeEvents, type SessionListItem } from '#/lib/api'
import { cn } from '#/lib/utils'
import { formatDistanceToNowStrict } from 'date-fns'
import { ScrollArea } from '#/components/ui/scroll-area'

export function SessionsSidebar() {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { location } = useRouterState()
  const activeSid = location.pathname.match(/\/sessions\/([^/]+)/)?.[1]

  async function reload() {
    try {
      const list = await api.listSessions()
      setSessions(list)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  useEffect(() => {
    reload()
    const interval = setInterval(reload, 5000)
    const stop = subscribeEvents(() => reload())
    return () => {
      clearInterval(interval)
      stop()
    }
  }, [])

  if (error) {
    return (
      <div className="p-4 text-xs text-destructive">
        Failed to load sessions: {error}
      </div>
    )
  }

  if (sessions === null) {
    return <div className="p-4 text-xs text-muted-foreground">Loading…</div>
  }

  if (sessions.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        No captured sessions yet.
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-2 flex flex-col gap-0.5">
        {sessions.map((s) => (
          <SessionRow key={s.sessionId} s={s} active={s.sessionId === activeSid} />
        ))}
      </div>
    </ScrollArea>
  )
}

function SessionRow({ s, active }: { s: SessionListItem; active: boolean }) {
  const time = s.startedAt ? new Date(s.startedAt) : new Date(s.mtime)
  return (
    <Link
      to="/sessions/$sid"
      params={{ sid: s.sessionId }}
      className={cn(
        'flex flex-col gap-1 px-3 py-2 rounded-md text-xs',
        'hover:bg-muted/60 transition-colors',
        active && 'bg-muted',
      )}
    >
      <div className="flex items-center gap-2">
        {s.isLive ? (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[color:var(--user)] opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[color:var(--user)]" />
          </span>
        ) : (
          <Circle className="w-2 h-2 opacity-30 fill-current" />
        )}
        <span className="font-medium text-foreground truncate">
          {s.cwd ? lastPathSeg(s.cwd) : s.sessionId.slice(0, 8)}
        </span>
        <span className="text-muted-foreground ml-auto tabular-nums">
          {formatDistanceToNowStrict(time, { addSuffix: false })}
        </span>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground tabular-nums">
        <span>{s.messageCount} msg</span>
        <span>·</span>
        <span>{s.interactionCount} call</span>
        {s.tokens.input + s.tokens.output > 0 && (
          <>
            <span>·</span>
            <span title="input → output tokens">
              {formatTokens(s.tokens.input)}→{formatTokens(s.tokens.output)}
            </span>
          </>
        )}
        {s.isLive && (
          <span className="ml-auto flex items-center gap-1 text-[color:var(--user)]">
            <Activity className="w-3 h-3" />
            live
          </span>
        )}
      </div>
      {s.cwd && (
        <div className="text-[10px] text-muted-foreground truncate font-mono opacity-70">
          {s.cwd}
        </div>
      )}
    </Link>
  )
}

function lastPathSeg(p: string): string {
  // Split on both `/` and `\` so Windows cwds (`C:\Users\foo\proj`)
  // render their basename rather than dumping the entire path.
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}
