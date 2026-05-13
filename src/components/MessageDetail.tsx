import { useEffect, useState, Fragment } from 'react'
import { api, subscribeEvents, type InteractionStub, type ProjectDetail } from '#/lib/api'
import { ScrollArea } from '#/components/ui/scroll-area'
import { Badge } from '#/components/ui/badge'
import { Separator } from '#/components/ui/separator'
import { InteractionCard } from '#/components/InteractionCard'
import { ActionExecutionSegment } from '#/components/ActionExecutionSegment'
import { AlertCircle } from 'lucide-react'

export function MessageDetail({ projectId, messageId }: { projectId: string; messageId: string }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    try {
      const d = await api.getProject(projectId)
      setDetail(d)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  useEffect(() => {
    reload()
    const stop = subscribeEvents((e) => {
      if (e.projectId === projectId) reload()
    })
    return stop
  }, [projectId, messageId])

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-destructive p-6">
        <div className="flex items-center gap-2 text-sm">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      </div>
    )
  }

  if (!detail) {
    return <div className="p-6 text-xs text-muted-foreground">Loading…</div>
  }

  const message = detail.messages.find((m) => m.messageId === messageId)
  if (!message) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground p-6 text-sm">
        Message not found.
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 pb-24 flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">Message #{message.index + 1}</span>
            <span>·</span>
            <span className="font-mono">{messageId.slice(0, 8)}</span>
            <span>·</span>
            <span>{message.interactions.length} iteration{message.interactions.length === 1 ? '' : 's'}</span>
            {message.stopReason === 'end_turn' && (
              <Badge variant="success" className="ml-1">ended on end_turn</Badge>
            )}
            {message.stopReason === 'tool_use' && (
              <Badge variant="warn" className="ml-1">still pending tool_use</Badge>
            )}
          </div>
          <StatsStrip interactions={message.interactions} />
        </header>

        <Separator />

        <div className="flex flex-col gap-3">
          {message.interactions.map((it, idx) => {
            // The action segment (if any) sits AFTER the iteration whose
            // response held the tool_use blocks. The next iteration's
            // request carries the paired tool_result blocks.
            const segment = message.actionSegments.find(
              (s) => s.fromInteractionId === it.interactionId,
            )
            return (
              <Fragment key={it.interactionId}>
                <InteractionCard
                  projectId={projectId}
                  stub={it}
                  index={idx}
                  total={message.interactions.length}
                />
                {segment && <ActionExecutionSegment segment={segment} />}
              </Fragment>
            )
          })}
        </div>
      </div>
    </ScrollArea>
  )
}

function StatsStrip({ interactions }: { interactions: InteractionStub[] }) {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let totalMs = 0
  let toolCount = 0
  for (const it of interactions) {
    input += it.usage?.input_tokens ?? 0
    output += it.usage?.output_tokens ?? 0
    cacheRead += it.usage?.cache_read_input_tokens ?? 0
    cacheWrite += it.usage?.cache_creation_input_tokens ?? 0
    totalMs += it.durationMs ?? 0
    toolCount += it.toolCount
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <Stat label="iterations" value={String(interactions.length)} />
      <Stat label="tool calls" value={String(toolCount)} />
      <Stat label="in" value={fmt(input)} />
      <Stat label="out" value={fmt(output)} />
      <Stat label="cache read" value={fmt(cacheRead)} />
      <Stat label="cache write" value={fmt(cacheWrite)} />
      <Stat label="total time" value={formatDuration(totalMs)} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1 px-2 py-1 rounded-md bg-muted/40 border border-border/50">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function fmt(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(2) + 'M'
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 1) return '–'
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60_000) return (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's'
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}
