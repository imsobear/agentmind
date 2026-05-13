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
import JsonView from '@uiw/react-json-view'
import { vscodeTheme } from '@uiw/react-json-view/vscode'
import {
  api,
  subscribeLive,
  type InteractionStub,
  type InteractionFull,
} from '#/lib/api'
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
  // Live-streaming state for the in-flight phase. We hold the latest
  // partial response separately so that:
  //   • snapshots that arrive BEFORE the initial getInteraction fetch
  //     completes are remembered and merged in later,
  //   • once endedAt lands we naturally fall back to the persisted
  //     record (which is authoritative — has sseEvents etc).
  const [livePartial, setLivePartial] = useState<InteractionFull['response'] | null>(null)
  const isLive = !stub.endedAt

  // Refetch whenever the stub changes shape — endedAt transitions from
  // undefined → ISO once the proxy writes the final record (request +
  // response + sseEvents). stopReason / durationMs join the stub at the
  // same moment but endedAt is the canonical "this interaction is now
  // complete" signal. Without this dep, the card would load the partial
  // (request-only) snapshot when the iter starts and never refresh
  // even after the stream completed — exactly the "response stayed
  // empty" / "request never updates" bug.
  useEffect(() => {
    if (!open) return
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
  }, [open, sessionId, stub.interactionId, stub.endedAt])

  // Live overlay: while the iter is open and hasn't ended yet, tail
  // the server's LiveRegistry so the response panel populates
  // incrementally instead of waiting for the persisted final record.
  // We unsubscribe once endedAt lands or the card collapses; the
  // server-side `done` event also auto-closes the EventSource. After
  // unsubscribe we clear `livePartial` so the persisted record (which
  // is now richer than what we held in memory) is the only source.
  useEffect(() => {
    if (!open || !isLive) {
      setLivePartial(null)
      return
    }
    const close = subscribeLive(sessionId, stub.interactionId, (snap) => {
      setLivePartial(snap.response ?? null)
    })
    return () => {
      close()
      setLivePartial(null)
    }
  }, [open, isLive, sessionId, stub.interactionId])

  // While the iter is live, tick a millisecond-resolution counter so
  // the header duration badge updates visibly even when the model is
  // mid-thought. 250ms is fine-grained enough to feel alive without
  // re-rendering the world on every animation frame.
  const [liveTick, setLiveTick] = useState(0)
  useEffect(() => {
    if (!isLive) return
    const id = setInterval(() => setLiveTick((t) => t + 1), 250)
    return () => clearInterval(id)
  }, [isLive])

  // The response surfaced to the panels:
  //   • Live: prefer `livePartial` (freshest snapshot). The server-side
  //     getInteraction splices the current registry snapshot into the
  //     initial fetch so late-mount cards still have something to
  //     show *before* the first live-update tick on the shared SSE
  //     channel — that's what `full.response` provides as a fallback
  //     until `livePartial` lands.
  //   • Done: the persisted record is authoritative.
  const overlayedFull: InteractionFull | null = full
    ? isLive
      ? livePartial
        ? { ...full, response: livePartial }
        : full
      : full
    : null

  // Live wall-clock duration: when `stub.durationMs` is missing
  // (interaction hasn't ended yet) we count from `stub.startedAt` so
  // the badge keeps moving. `liveTick` participates in the deps to
  // force a re-evaluation every 250ms while live.
  void liveTick
  const displayedDurationMs = stub.durationMs
    ?? (isLive ? Date.now() - new Date(stub.startedAt).getTime() : undefined)

  const sseEvents = full?.sseEvents ?? []
  const iterLabel = `iter ${index + 1}/${total}`

  return (
    <Card className="overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // flex-wrap + min-w-0 on the row + truncate on the model name
          // is what keeps the chip cluster visible at narrow pane widths.
          // Without this, chip count × badge width quickly exceeds the
          // pane and the rightmost chips were getting clipped by main's
          // overflow-hidden (no horizontal scrollbar, so they just
          // vanished).
          'w-full min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left hover:bg-muted/30 transition-colors',
          open && 'border-b border-border/50 bg-muted/20',
        )}
      >
        <span className="text-muted-foreground shrink-0">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <span className="text-[color:var(--llm)] flex items-center gap-1.5 text-xs shrink-0">
          <Send className="w-3.5 h-3.5" />
          <span className="font-mono tabular-nums">
            iter {index + 1}/{total}
          </span>
        </span>
        <Badge
          variant="info"
          className="!text-[10px] !py-0 gap-1 shrink-0"
          title="Remote LLM call · request forwarded to api.anthropic.com, response streamed back through this proxy"
        >
          <Cloud className="w-2.5 h-2.5" />
          remote
        </Badge>
        <span
          className="text-xs text-muted-foreground font-mono min-w-0 flex-1 truncate"
          title={stub.model || undefined}
        >
          {stub.model || '–'}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px]">
          {stub.usage?.input_tokens != null && (
            <Badge variant="muted" className="shrink-0" title="input tokens">
              in {fmt(stub.usage.input_tokens)}
            </Badge>
          )}
          {stub.usage?.output_tokens != null && (
            <Badge variant="muted" className="shrink-0" title="output tokens">
              out {fmt(stub.usage.output_tokens)}
            </Badge>
          )}
          {stub.usage?.cache_read_input_tokens != null && stub.usage.cache_read_input_tokens > 0 && (
            <Badge variant="muted" className="shrink-0" title="cache-read tokens">
              cache {fmt(stub.usage.cache_read_input_tokens)}
            </Badge>
          )}
          {displayedDurationMs != null && (
            <Badge variant="muted" className="shrink-0" title={isLive ? 'live duration · ticking' : 'duration'}>
              <Clock className="w-3 h-3" />
              {formatDuration(displayedDurationMs)}
            </Badge>
          )}
          {isLive ? (
            // While the upstream is still streaming we replace the
            // stop_reason badge with a pulsing "streaming" indicator —
            // the user shouldn't have to wait for the final record to
            // know the iter is alive.
            <Badge
              variant="warn"
              className="gap-1 shrink-0"
              title="Upstream is still streaming · response is being assembled live"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--warn)] animate-pulse" />
              streaming
            </Badge>
          ) : (
            stub.stopReason && (
              <Badge
                variant={stub.stopReason === 'end_turn' ? 'success' : 'warn'}
                className="shrink-0"
              >
                {stub.stopReason}
              </Badge>
            )
          )}
          {stub.hasError && (
            <Badge variant="danger" className="gap-1 shrink-0">
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
                overlayedFull && (
                  <RawJsonButton
                    obj={overlayedFull.request}
                    title={`${iterLabel} · raw request JSON`}
                  />
                )
              }
            />
            {error && <div className="p-4 text-xs text-destructive">{error}</div>}
            {!error && !overlayedFull && <div className="p-4 text-xs text-muted-foreground">Loading…</div>}
            {overlayedFull && (
              <RequestPanel
                interaction={overlayedFull}
                prevMessageCount={stub.prevMessageCount ?? 0}
              />
            )}
          </section>
          <section className="min-w-0">
            <PanelHeader
              icon={<MessagesSquare className="w-3.5 h-3.5" />}
              label="RESPONSE"
              timestamp={stub.endedAt}
              chips={
                overlayedFull && (
                  <>
                    {sseEvents.length > 0 && (
                      <SseTimelineButton
                        events={sseEvents}
                        title={`${iterLabel} · SSE timeline`}
                      />
                    )}
                    <RawJsonButton
                      obj={overlayedFull.response ?? overlayedFull.error ?? {}}
                      title={`${iterLabel} · raw response JSON`}
                    />
                  </>
                )
              }
            />
            {overlayedFull && <ResponsePanel interaction={overlayedFull} />}
            {!overlayedFull && !error && (
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
  // Approximate payload size for the header chip. We measure on the
  // stringified value because the user thinks of "raw JSON" in those
  // terms ("how big is this request?"), and counting object keys
  // wouldn't translate to a meaningful answer.
  const charCount = (() => {
    try {
      return JSON.stringify(obj)?.length ?? 0
    } catch {
      return 0
    }
  })()

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
            {charCount.toLocaleString()} chars
          </span>
        </DialogHeader>
        <DialogBody className="p-3">
          {/* Tree view with per-node fold/unfold. `collapsed={2}` keeps
              top-level + first-level keys open by default but folds
              deeper structures — large payloads (system prompts, tool
              schemas, message lists) stay scannable instead of
              dumping thousands of lines at once. */}
          <JsonView
            value={obj as object}
            style={{
              ...vscodeTheme,
              fontSize: '12px',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              backgroundColor: 'transparent',
            }}
            collapsed={2}
            displayDataTypes={false}
            displayObjectSize
            shortenTextAfterLength={240}
            enableClipboard
          />
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
