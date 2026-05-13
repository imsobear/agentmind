import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Send,
  AlertCircle,
  Clock,
  Inbox,
  MessagesSquare,
  Cloud,
  Braces,
  Activity,
} from 'lucide-react'
import { api, type InteractionStub, type InteractionFull } from '#/lib/api'
import type { SseEvent } from '#/lib/anthropic-types'
import { Badge } from '#/components/ui/badge'
import { Card } from '#/components/ui/card'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
} from '#/components/ui/dialog'
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
  const [open, setOpen] = useState(true)

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

  const sseEvents = full?.sseEvents ?? []
  const iterLabel = `iter ${index + 1}/${total}`

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
            <PanelHeader
              icon={<Inbox className="w-3.5 h-3.5" />}
              label="REQUEST"
              timestamp={stub.startedAt}
              chips={
                full && (
                  <RawJsonButton
                    obj={full.request}
                    title={`${iterLabel} · raw request JSON`}
                  />
                )
              }
            />
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
                full && (
                  <>
                    {sseEvents.length > 0 && (
                      <SseTimelineButton
                        events={sseEvents}
                        title={`${iterLabel} · SSE timeline`}
                      />
                    )}
                    <RawJsonButton
                      obj={full.response ?? full.error ?? {}}
                      title={`${iterLabel} · raw response JSON`}
                    />
                  </>
                )
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
    // min-h here keeps the REQUEST and RESPONSE header bars the same
    // height even if one side ends up with no chips (e.g. an empty
    // response or a request that hasn't loaded its full payload yet).
    <div className="px-3 py-1.5 min-h-[34px] border-b border-border/50 flex items-center gap-2 text-[10px] uppercase tracking-wider">
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

/**
 * Icon button that opens a dialog showing the pretty-printed JSON of
 * the given object. Used in the REQUEST / RESPONSE panel headers to
 * surface the raw payload without polluting the structured view below.
 */
function RawJsonButton({ obj, title }: { obj: unknown; title: string }) {
  const json = JSON.stringify(obj, null, 2) ?? 'null'
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={title}
          title="View raw JSON"
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <Braces className="w-3.5 h-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Braces className="w-4 h-4" />
            {title}
          </DialogTitle>
          <span className="ml-auto text-[10px] text-muted-foreground tabular-nums font-mono">
            {json.length.toLocaleString()} chars
          </span>
        </DialogHeader>
        <DialogBody className="p-0">
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words p-4 leading-relaxed">
            {json}
          </pre>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Icon button that opens a dialog showing the raw SSE event timeline
 * captured during the response stream. One line per event with type
 * and a short human-readable summary.
 */
function SseTimelineButton({
  events,
  title,
}: {
  events: SseEvent[]
  title: string
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={title}
          title={`View SSE timeline · ${events.length} events`}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <Activity className="w-3.5 h-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Activity className="w-4 h-4" />
            {title}
          </DialogTitle>
          <span className="ml-auto text-[10px] text-muted-foreground tabular-nums font-mono">
            {events.length} event{events.length === 1 ? '' : 's'}
          </span>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-0.5 font-mono text-[11px]">
            {events.map((e, i) => (
              <div key={i} className="flex items-start gap-2 py-0.5">
                <span className="tabular-nums text-muted-foreground w-8 shrink-0 text-right">
                  {i}
                </span>
                <span className="text-[color:var(--llm)] shrink-0">{e.type}</span>
                <span className="text-muted-foreground/80 truncate">
                  {summarizeEvent(e)}
                </span>
              </div>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function summarizeEvent(e: SseEvent): string {
  switch (e.type) {
    case 'message_start':
      return `id=${e.message.id} model=${e.message.model}`
    case 'content_block_start':
      return `index=${e.index} kind=${e.content_block.type}`
    case 'content_block_delta': {
      const d: any = e.delta
      if (d.type === 'text_delta') return `text +${d.text.length}c`
      if (d.type === 'thinking_delta') return `thinking +${d.thinking.length}c`
      if (d.type === 'input_json_delta') return `input_json +${d.partial_json.length}c`
      if (d.type === 'signature_delta') return `signature +${d.signature.length}c`
      return d.type
    }
    case 'content_block_stop':
      return `index=${e.index}`
    case 'message_delta':
      return `stop_reason=${(e.delta as any).stop_reason ?? ''} ${e.usage ? `usage(out=${e.usage.output_tokens})` : ''}`
    case 'message_stop':
      return ''
    case 'ping':
      return ''
    case 'error':
      return `${(e as any).error?.type}: ${(e as any).error?.message}`
    default:
      return ''
  }
}
