import { useEffect, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { api, subscribeEvents, type SessionDetail } from '#/lib/api'
import { cn } from '#/lib/utils'
import { Badge } from '#/components/ui/badge'
import { ScrollArea } from '#/components/ui/scroll-area'
import { format } from 'date-fns'

export function MessagesPane() {
  const { location } = useRouterState()
  const m = location.pathname.match(/^\/sessions\/([^/]+)(?:\/messages\/([^/]+))?/)
  const sid = m?.[1]
  const activeMid = m?.[2]

  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload(id: string) {
    try {
      const d = await api.getSession(id)
      setDetail(d)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  useEffect(() => {
    if (!sid) {
      setDetail(null)
      return
    }
    reload(sid)
    const stop = subscribeEvents((e) => {
      if (e.sessionId === sid) reload(sid)
    })
    return stop
  }, [sid])

  if (!sid) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Select a session on the left.
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-xs text-destructive">
        Failed to load: {error}
      </div>
    )
  }

  if (!detail) {
    return <div className="p-4 text-xs text-muted-foreground">Loading…</div>
  }

  // Render newest message first so live tail and recent prompts are
  // immediately visible without scrolling. The per-row `#index` badge
  // still reflects the original (oldest-first) chronological order.
  const visibleMessages = [...detail.messages].reverse()
  return (
    <>
      <div className="px-4 py-3 border-b border-border">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Session
        </div>
        <div className="font-mono text-xs truncate mt-0.5">{sid}</div>
        {detail.session?.cwd && (
          <div className="text-[10px] text-muted-foreground font-mono truncate mt-1">
            cwd: {detail.session.cwd}
          </div>
        )}
        <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
          {visibleMessages.length} message{visibleMessages.length === 1 ? '' : 's'}
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 flex flex-col gap-1">
          {visibleMessages.map((m) => (
            <Link
              key={m.messageId}
              to="/sessions/$sid/messages/$mid"
              params={{ sid, mid: m.messageId }}
              className={cn(
                'flex flex-col gap-1.5 px-3 py-2.5 rounded-md text-xs hover:bg-muted/60 transition-colors',
                m.messageId === activeMid && 'bg-muted',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-[color:var(--user)] font-medium tabular-nums">
                  #{m.index + 1}
                </span>
                <span className="text-muted-foreground tabular-nums text-[10px]">
                  {m.startedAt ? format(new Date(m.startedAt), 'HH:mm:ss') : ''}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  <Badge variant="info" className="!py-0">
                    {m.interactions.length} iter
                  </Badge>
                  {m.stopReason === 'end_turn' && (
                    <Badge variant="success" className="!py-0">
                      done
                    </Badge>
                  )}
                  {m.stopReason === 'tool_use' && (
                    <Badge variant="warn" className="!py-0">
                      open
                    </Badge>
                  )}
                </span>
              </div>
              <div className="text-foreground line-clamp-3 leading-relaxed">
                {m.firstUserText?.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() ||
                  <span className="text-muted-foreground italic">(no text)</span>}
              </div>
            </Link>
          ))}
        </div>
      </ScrollArea>
    </>
  )
}
