// RESPONSE panel for OpenAI Responses-API traffic (Codex CLI).
//
// Renders the `output[]` array — each item is a typed block (message,
// reasoning, function_call, …). Layout mirrors the Anthropic
// ResponsePanel: one block per row, with the typed chrome on the
// left and the structured payload on the right.

import { Type, Wrench, Brain, Globe, Image as ImageIcon } from 'lucide-react'
import type { InteractionFull } from '#/lib/api'
import type {
  ResponsesObject,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesFunctionCallItem,
  ResponsesCustomToolCallItem,
  ResponsesReasoningItem,
  ResponsesLocalShellCallItem,
  ResponsesWebSearchCallItem,
  ResponsesImageGenerationCallItem,
  ResponsesContentItem,
} from '#/lib/openai-responses-types'
import { Badge } from '#/components/ui/badge'
import { cn } from '#/lib/utils'

export function ResponsesResponsePanel({
  interaction,
}: {
  interaction: InteractionFull
}) {
  const resp = interaction.response as ResponsesObject | undefined
  if (!resp) {
    if (interaction.error) {
      return (
        <div className="p-3 text-xs">
          <Badge variant="danger">error</Badge>
          <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-words text-destructive">
            {interaction.error.message}
            {interaction.error.status ? ` (status ${interaction.error.status})` : ''}
          </pre>
        </div>
      )
    }
    return <div className="p-3 text-xs text-muted-foreground italic">(no response yet)</div>
  }
  const output = resp.output ?? []
  return (
    <div className="p-3 flex flex-col gap-1.5 text-xs">
      {output.length === 0 && (
        <div className="text-muted-foreground italic">(output empty so far)</div>
      )}
      {output.map((item, i) => (
        <div key={i} className="max-h-96 overflow-auto">
          <OutputItemView item={item} />
        </div>
      ))}
    </div>
  )
}

function OutputItemView({ item }: { item: ResponsesOutputItem }) {
  if (item.type === 'message') return <MessageView item={item as ResponsesOutputMessage} />
  if (item.type === 'reasoning') return <ReasoningView item={item as ResponsesReasoningItem} />
  if (item.type === 'function_call') {
    return <FunctionCallView item={item as ResponsesFunctionCallItem} />
  }
  if (item.type === 'custom_tool_call') {
    return <CustomToolCallView item={item as ResponsesCustomToolCallItem} />
  }
  if (item.type === 'local_shell_call') {
    return <LocalShellCallView item={item as ResponsesLocalShellCallItem} />
  }
  if (item.type === 'web_search_call') {
    return <WebSearchView item={item as ResponsesWebSearchCallItem} />
  }
  if (item.type === 'image_generation_call') {
    return <ImageGenView item={item as ResponsesImageGenerationCallItem} />
  }
  return <UnknownItemView item={item} />
}

function MessageView({ item }: { item: ResponsesOutputMessage }) {
  return (
    <div className="rounded border border-[color:var(--llm)]/20 bg-[color:var(--llm)]/5 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--llm)] mb-1 flex items-center gap-1.5">
        <Type className="w-3 h-3" />
        <span>message</span>
        <span className="font-mono normal-case text-foreground/70">#{item.role}</span>
        {item.phase && (
          <Badge variant="muted" className="!py-0 !text-[10px] ml-1">
            {item.phase}
          </Badge>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {item.content.map((c, i) => (
          <ContentBlockView key={i} block={c} />
        ))}
      </div>
    </div>
  )
}

function ContentBlockView({ block }: { block: ResponsesContentItem }) {
  if (block.type === 'output_text' || block.type === 'input_text') {
    return (
      <div className="text-[12px] whitespace-pre-wrap break-words leading-relaxed">
        {(block as { text: string }).text}
      </div>
    )
  }
  if (block.type === 'input_image') {
    return (
      <div className="text-[11px] text-muted-foreground italic">
        [input_image: {block.image_url.slice(0, 80)}{block.image_url.length > 80 ? '…' : ''}]
      </div>
    )
  }
  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words opacity-70">
      {JSON.stringify(block, null, 2)}
    </pre>
  )
}

function ReasoningView({ item }: { item: ResponsesReasoningItem }) {
  const summary = (item.summary ?? []).filter((s) => s?.text).map((s) => s.text)
  const content = (item.content ?? []).filter((c) => c?.text).map((c) => c.text!)
  return (
    <div className="rounded border border-[color:var(--thinking)]/30 bg-[color:var(--thinking)]/5 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--thinking)] mb-1 flex items-center gap-1.5">
        <Brain className="w-3 h-3" />
        <span>reasoning</span>
        {item.encrypted_content && (
          <Badge variant="muted" className="!py-0 !text-[10px] ml-auto">
            encrypted blob
          </Badge>
        )}
      </div>
      {summary.length > 0 && (
        <div className="text-[12px] whitespace-pre-wrap break-words leading-relaxed italic mb-1">
          {summary.join('\n')}
        </div>
      )}
      {content.length > 0 && (
        <div className="text-[12px] whitespace-pre-wrap break-words leading-relaxed">
          {content.join('\n')}
        </div>
      )}
      {summary.length === 0 && content.length === 0 && (
        <div className="text-[11px] text-muted-foreground italic">
          (reasoning step had no readable summary or content)
        </div>
      )}
    </div>
  )
}

function FunctionCallView({ item }: { item: ResponsesFunctionCallItem }) {
  return (
    <div className="rounded border border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[color:var(--tool)] mb-1 min-w-0">
        <Wrench className="w-3 h-3 shrink-0" />
        <span className="shrink-0">function_call</span>
        <span className="font-mono normal-case text-foreground/90 shrink-0">{item.name}</span>
        <span
          className="text-muted-foreground font-mono normal-case ml-auto truncate min-w-0"
          title={item.call_id}
        >
          {item.call_id}
        </span>
      </div>
      <ArgumentsPre args={item.arguments} />
    </div>
  )
}

function CustomToolCallView({ item }: { item: ResponsesCustomToolCallItem }) {
  return (
    <div className="rounded border border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[color:var(--tool)] mb-1 min-w-0">
        <Wrench className="w-3 h-3 shrink-0" />
        <span className="shrink-0">custom_tool_call</span>
        <span className="font-mono normal-case text-foreground/90 shrink-0">{item.name}</span>
        <span
          className="text-muted-foreground font-mono normal-case ml-auto truncate min-w-0"
          title={item.call_id}
        >
          {item.call_id}
        </span>
      </div>
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto bg-background/60 rounded p-2 border border-border/40">
        {item.input}
      </pre>
    </div>
  )
}

function LocalShellCallView({ item }: { item: ResponsesLocalShellCallItem }) {
  return (
    <div className="rounded border border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[color:var(--tool)] mb-1">
        <Wrench className="w-3 h-3" />
        <span>local_shell_call</span>
        <Badge variant="muted" className="!py-0 !text-[10px] ml-2">
          {item.status}
        </Badge>
        {item.call_id && (
          <span className="text-muted-foreground font-mono normal-case ml-auto">{item.call_id}</span>
        )}
      </div>
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto bg-background/60 rounded p-2 border border-border/40">
        {JSON.stringify(item.action, null, 2)}
      </pre>
    </div>
  )
}

function WebSearchView({ item }: { item: ResponsesWebSearchCallItem }) {
  return (
    <div className="rounded border border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[color:var(--tool)] mb-1">
        <Globe className="w-3 h-3" />
        <span>web_search_call</span>
        {item.status && (
          <Badge variant="muted" className="!py-0 !text-[10px] ml-2">
            {item.status}
          </Badge>
        )}
      </div>
      {item.action && (
        <div className="text-[12px] font-mono break-words">
          <span className="text-muted-foreground">{item.action.type}: </span>
          <span>{item.action.query ?? ''}</span>
        </div>
      )}
    </div>
  )
}

function ImageGenView({ item }: { item: ResponsesImageGenerationCallItem }) {
  return (
    <div className="rounded border border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[color:var(--tool)] mb-1">
        <ImageIcon className="w-3 h-3" />
        <span>image_generation_call</span>
        {item.status && (
          <Badge variant="muted" className="!py-0 !text-[10px] ml-2">
            {item.status}
          </Badge>
        )}
      </div>
      {item.revised_prompt && (
        <div className="text-[12px] italic text-foreground/80 mb-1">{item.revised_prompt}</div>
      )}
      {item.result && (
        <div className="text-[11px] text-muted-foreground">
          [{Math.round(item.result.length / 1024)} kB image payload]
        </div>
      )}
    </div>
  )
}

function UnknownItemView({ item }: { item: ResponsesOutputItem }) {
  return (
    <div className={cn('rounded border border-border/60 bg-background/40 px-2 py-1.5')}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-mono">
        {(item as { type: string }).type}
      </div>
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto opacity-80">
        {JSON.stringify(item, null, 2)}
      </pre>
    </div>
  )
}

function ArgumentsPre({ args }: { args: string }) {
  // Codex `function_call.arguments` is a raw JSON string — pretty-print
  // if it parses, fall back to the raw string if it doesn't (mid-stream
  // partial deltas are by definition mid-parse).
  let display: string = args
  try {
    const parsed = JSON.parse(args)
    display = JSON.stringify(parsed, null, 2)
  } catch {
    display = args
  }
  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto bg-background/60 rounded p-2 border border-border/40">
      {display}
    </pre>
  )
}
