import { useEffect, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { api, subscribeEvents, type ProjectDetail } from '#/lib/api'
import { cn } from '#/lib/utils'
import { Badge } from '#/components/ui/badge'
import { ScrollArea } from '#/components/ui/scroll-area'
import { format } from 'date-fns'

export function MessagesPane() {
  const { location } = useRouterState()
  const m = location.pathname.match(/^\/projects\/([^/]+)(?:\/messages\/([^/]+))?/)
  const pid = m?.[1]
  const activeMid = m?.[2]

  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload(id: string) {
    try {
      const d = await api.getProject(id)
      setDetail(d)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  useEffect(() => {
    if (!pid) {
      setDetail(null)
      return
    }
    reload(pid)
    const stop = subscribeEvents((e) => {
      if (e.projectId === pid) reload(pid)
    })
    return stop
  }, [pid])

  if (!pid) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Select a project on the left.
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
  // No column header — cwd and message count both already appear on
  // the project row in the sidebar, so a second copy here was a static
  // chrome row that didn't earn its 60px. The messages list just
  // starts at the top of the column.
  return (
    <>
      <ScrollArea className="flex-1">
        <div className="p-2 flex flex-col gap-1">
          {visibleMessages.map((m) => (
            <Link
              key={m.messageId}
              to="/projects/$pid/messages/$mid"
              params={{ pid, mid: m.messageId }}
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
