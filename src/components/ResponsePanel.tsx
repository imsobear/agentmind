import { AlertCircle } from 'lucide-react'
import type { InteractionFull } from '#/lib/api'
import type { AnthropicResponse, ContentBlock } from '#/lib/anthropic-types'
import { ContentBlockView } from '#/components/RequestPanel'

export function ResponsePanel({ interaction }: { interaction: InteractionFull }) {
  // Only mounted by InteractionCard for `agentType === 'claude-code'`.
  // Narrow here so the rest of the component is strongly-typed.
  const resp = interaction.response as AnthropicResponse | undefined
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
      {/* SSE timeline + raw JSON are no longer rendered inline — the
          header buttons in InteractionCard open them in modals so this
          column stays focused on the structured response blocks. */}
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
        // Same cap as request-side blocks — long thinking or text
        // responses scroll inside the row. No leading numeric gutter:
        // each block kind already has distinct chrome.
        <div key={i} className="max-h-80 overflow-auto">
          <ContentBlockView block={b} />
        </div>
      ))}
    </div>
  )
}

