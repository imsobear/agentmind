import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Send, Brain, Wrench, AlertCircle, Clock, Inbox, MessagesSquare, Type, Cloud } from 'lucide-react'
import { api, type InteractionStub, type InteractionFull } from '#/lib/api'
import { Badge } from '#/components/ui/badge'
import { Card } from '#/components/ui/card'
import { cn } from '#/lib/utils'
import { format } from 'date-fns'
import { RequestPanel } from '#/components/RequestPanel'
import { ResponsePanel } from '#/components/ResponsePanel'
import { formatDuration } from '#/components/MessageDetail'

export function InteractionCard({
  sessionId,
  stub,
  index,
  total,
}: {
  sessionId: string
  stub: InteractionStub
  index: number
  total: number
}) {
  const [full, setFull] = useState<InteractionFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(index === 0) // first iteration expanded by default

  useEffect(() => {
    if (!open || full) return
    let cancelled = false
    api
      .getInteraction(sessionId, stub.interactionId)
      .then((d) => {
        if (!cancelled) setFull(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? String(e))
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId, stub.interactionId, full])

  const blocks = full?.response?.content ?? []
  const thinkingCount = blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length
  const textCount = blocks.filter((b) => b.type === 'text').length
  const toolCount = blocks.filter((b) => b.type === 'tool_use').length

  return (
    <Card className="overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors',
          open && 'border-b border-border/50 bg-muted/20',
        )}
      >
        <span className="text-muted-foreground">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <span className="text-[color:var(--llm)] flex items-center gap-1.5 text-xs">
          <Send className="w-3.5 h-3.5" />
          <span className="font-mono tabular-nums">
            iter {index + 1}/{total}
          </span>
        </span>
        <Badge
          variant="info"
          className="!text-[10px] !py-0 gap-1"
          title="Remote LLM call · request forwarded to api.anthropic.com, response streamed back through this proxy"
        >
          <Cloud className="w-2.5 h-2.5" />
          remote
        </Badge>
        <span className="text-xs text-muted-foreground font-mono">
          {stub.model || '–'}
        </span>
        <div className="ml-auto flex items-center gap-1.5 text-[11px]">
          {stub.usage?.input_tokens != null && (
            <Badge variant="muted" title="input tokens">
              in {fmt(stub.usage.input_tokens)}
            </Badge>
          )}
          {stub.usage?.output_tokens != null && (
            <Badge variant="muted" title="output tokens">
              out {fmt(stub.usage.output_tokens)}
            </Badge>
          )}
          {stub.usage?.cache_read_input_tokens != null && stub.usage.cache_read_input_tokens > 0 && (
            <Badge variant="muted" title="cache-read tokens">
              cache {fmt(stub.usage.cache_read_input_tokens)}
            </Badge>
          )}
          {stub.durationMs != null && (
            <Badge variant="muted" title="duration">
              <Clock className="w-3 h-3" />
              {formatDuration(stub.durationMs)}
            </Badge>
          )}
          {stub.stopReason && (
            <Badge variant={stub.stopReason === 'end_turn' ? 'success' : 'warn'}>
              {stub.stopReason}
            </Badge>
          )}
          {stub.hasError && (
            <Badge variant="danger" className="gap-1">
              <AlertCircle className="w-3 h-3" />
              error
            </Badge>
          )}
        </div>
      </button>

      {open && (
        <div className="grid grid-cols-2 gap-0 divide-x divide-border/50">
          <section className="min-w-0">
            <PanelHeader icon={<Inbox className="w-3.5 h-3.5" />} label="REQUEST" timestamp={stub.startedAt} />
            {error && <div className="p-4 text-xs text-destructive">{error}</div>}
            {!error && !full && <div className="p-4 text-xs text-muted-foreground">Loading…</div>}
            {full && (
              <RequestPanel interaction={full} prevMessageCount={stub.prevMessageCount ?? 0} />
            )}
          </section>
          <section className="min-w-0">
            <PanelHeader
              icon={<MessagesSquare className="w-3.5 h-3.5" />}
              label="RESPONSE"
              timestamp={stub.endedAt}
              chips={
                <>
                  {thinkingCount > 0 && (
                    <Badge variant="thinking" className="gap-1">
                      <Brain className="w-3 h-3" />
                      {thinkingCount}
                    </Badge>
                  )}
                  {textCount > 0 && (
                    <Badge variant="info" className="gap-1">
                      <Type className="w-3 h-3" />
                      {textCount}
                    </Badge>
                  )}
                  {toolCount > 0 && (
                    <Badge variant="tool" className="gap-1">
                      <Wrench className="w-3 h-3" />
                      {toolCount}
                    </Badge>
                  )}
                </>
              }
            />
            {full && <ResponsePanel interaction={full} />}
            {!full && !error && (
              <div className="p-4 text-xs text-muted-foreground">Loading…</div>
            )}
          </section>
        </div>
      )}
    </Card>
  )
}

function PanelHeader({
  icon,
  label,
  timestamp,
  chips,
}: {
  icon?: React.ReactNode
  label: string
  timestamp?: string
  chips?: React.ReactNode
}) {
  return (
    <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2 text-[10px] uppercase tracking-wider">
      <span className="text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      {timestamp && (
        <span className="text-muted-foreground tabular-nums font-mono normal-case lowercase">
          {format(new Date(timestamp), 'HH:mm:ss.SSS')}
        </span>
      )}
      {chips && <span className="ml-auto flex items-center gap-1">{chips}</span>}
    </div>
  )
}

function fmt(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(2) + 'M'
}
