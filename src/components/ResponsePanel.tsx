import { useState } from 'react'
import { ChevronDown, ChevronRight, Activity, AlertCircle } from 'lucide-react'
import type { InteractionFull } from '#/lib/api'
import type { ContentBlock, SseEvent } from '#/lib/anthropic-types'
import { ContentBlockView, RawJsonToggle } from '#/components/RequestPanel'

export function ResponsePanel({ interaction }: { interaction: InteractionFull }) {
  const resp = interaction.response
  if (interaction.error) {
    return (
      <div className="p-3 text-xs">
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="w-4 h-4" />
            <span className="font-medium">
              {interaction.error.status ? `${interaction.error.status} error` : 'error'}
            </span>
          </div>
          <pre className="text-[11px] whitespace-pre-wrap break-words font-mono">
            {interaction.error.message}
          </pre>
        </div>
        {(resp || interaction.sseEvents?.length) && (
          <div className="mt-3">
            <div className="text-[10px] uppercase text-muted-foreground mb-2">
              partial data received
            </div>
            <NumberedBlocks blocks={resp?.content ?? []} />
          </div>
        )}
      </div>
    )
  }

  if (!resp) {
    return <div className="p-3 text-xs text-muted-foreground">No response captured yet.</div>
  }

  return (
    <div className="p-3 flex flex-col gap-3 text-xs">
      <NumberedBlocks blocks={resp.content} />
      <SseSection events={interaction.sseEvents} />
      <RawJsonToggle obj={resp} label="raw response JSON" />
    </div>
  )
}

function NumberedBlocks({ blocks }: { blocks: ContentBlock[] }) {
  if (!blocks.length) {
    return <div className="text-muted-foreground italic">empty content</div>
  }
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => (
        <div key={i} className="flex gap-2 items-start">
          <span className="text-[10px] text-muted-foreground font-mono tabular-nums mt-2 shrink-0 w-6 text-right">
            {i + 1}
          </span>
          {/* Same cap as request-side numbered blocks — long thinking
              or text responses scroll inside the row. */}
          <div className="flex-1 min-w-0 max-h-80 overflow-auto">
            <ContentBlockView block={b} />
          </div>
        </div>
      ))}
    </div>
  )
}

function SseSection({ events }: { events?: SseEvent[] }) {
  const [open, setOpen] = useState(false)
  if (!events?.length) return null
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <span>{open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</span>
        <Activity className="w-3.5 h-3.5" />
        <span className="font-medium">SSE timeline</span>
        <span className="normal-case tracking-normal text-muted-foreground/80">· {events.length} events</span>
      </button>
      {open && (
        <div className="mt-2 ml-1 flex flex-col gap-0.5 font-mono text-[10px] max-h-96 overflow-auto">
          {events.map((e, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5">
              <span className="tabular-nums text-muted-foreground w-8 shrink-0">{i}</span>
              <span className="text-[color:var(--llm)] shrink-0">{e.type}</span>
              <span className="text-muted-foreground/80 truncate">
                {summarizeEvent(e)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
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

