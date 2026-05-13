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
  // The header used to lead with "SESSION <uuid>" — but the user never
  // refers to sessions by their internal id, they identify them by
  // working directory, which is also what we now key sessions on. So
  // the title row shows cwd (or a neutral fallback) and message count
  // only; the sessionId stays in the URL for navigation but never
  // leaks into the chrome.
  return (
    <>
      {/* The min-h here mirrors the sidebar Header so both columns line
          up to the same baseline regardless of typography. Once height
          is structural we can size the cwd line independently. */}
      {/* The cwd row is the column's "title", but it must not outshout
          the product wordmark in the left column. We use the same
          muted-foreground colour as supporting metadata; mono font is
          kept because cwd is a path, but the lower contrast brings the
          visual weight back below "claude-proxy". */}
      <div className="px-4 border-b border-border min-h-[60px] flex flex-col justify-center">
        <div
          className="font-mono text-xs text-muted-foreground truncate"
          title={detail.session?.cwd ?? 'cwd unknown'}
        >
          {detail.session?.cwd ?? (
            <span className="italic">cwd unknown</span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground/70 mt-0.5 tabular-nums">
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
