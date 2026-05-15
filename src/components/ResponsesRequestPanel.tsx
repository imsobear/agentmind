// REQUEST panel for OpenAI Responses-API traffic (Codex CLI).
//
// Renders the Codex `input[]` transcript as a flat list of role-tagged
// sections, plus the system-level `instructions` and the tool catalogue.
// Mirrors the layout idiom of the Anthropic RequestPanel — folded
// sections under one column — so the user can read both protocols with
// the same eye movements.

import { useMemo } from 'react'
import { FileCode2, Wrench, User, Bot, Settings2, FileSearch } from 'lucide-react'
import type { InteractionFull } from '#/lib/api'
import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesInputMessage,
  ResponsesFunctionCallOutput,
  ResponsesCustomToolCallOutput,
  ResponsesMcpToolCallOutput,
  ResponsesContentItem,
  FunctionCallOutputPayload,
} from '#/lib/openai-responses-types'
import { Badge } from '#/components/ui/badge'
import { Section } from '#/components/RequestPanel'
import { cn } from '#/lib/utils'

export function ResponsesRequestPanel({
  interaction,
  prevMessageCount = 0,
}: {
  interaction: InteractionFull
  prevMessageCount?: number
}) {
  const req = interaction.request as ResponsesRequest
  const items = req.input ?? []
  const tools = req.tools ?? []
  return (
    <div className="p-3 flex flex-col gap-2 text-xs">
      {items
        .map((item, i) => ({
          item,
          i,
          // Items appended since the previous iteration. `prevMessageCount`
          // here is `input.length` of the prior iter (server-computed in
          // interaction-view.transcriptLength).
          isNew: i >= prevMessageCount && prevMessageCount > 0,
        }))
        .reverse()
        .map(({ item, i, isNew }) => (
          <InputItemSection key={i} item={item} isNew={isNew} />
        ))}
      {req.instructions && <InstructionsSection text={req.instructions} />}
      {tools.length > 0 && <ToolsSection tools={tools} />}
    </div>
  )
}

function InputItemSection({ item, isNew }: { item: ResponsesInputItem; isNew: boolean }) {
  const inlineSummary = useMemo(() => summariseItem(item), [item])
  const { icon, title, accent } = headerForItem(item)
  return (
    <Section
      title={title}
      icon={icon}
      summary={
        <>
          {inlineSummary && (
            <span className="italic text-foreground/70 truncate flex-1 min-w-0">
              "{inlineSummary}"
            </span>
          )}
          {isNew && (
            <Badge
              variant="success"
              className="ml-auto !text-[10px] !py-0 shrink-0"
              title="Appended to input[] between this iter and the previous one"
            >
              new
            </Badge>
          )}
        </>
      }
      defaultOpen={false}
    >
      <InputItemBody item={item} accent={accent} />
    </Section>
  )
}

function headerForItem(item: ResponsesInputItem) {
  if (item.type === 'message') {
    const isUser = item.role === 'user'
    return {
      icon: isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />,
      accent: isUser ? 'user' : 'llm',
      title: (
        <span className="flex items-baseline gap-0.5">
          <span>input</span>
          <span
            className={cn(
              'font-mono opacity-50',
              isUser ? 'text-[color:var(--user)]' : 'text-[color:var(--llm)]',
            )}
          >
            #{item.role}
          </span>
        </span>
      ),
    }
  }
  return {
    icon: <Wrench className="w-3.5 h-3.5" />,
    accent: 'tool',
    title: (
      <span className="flex items-baseline gap-0.5">
        <span>input</span>
        <span className="font-mono opacity-50 text-[color:var(--tool)]">
          #{item.type}
        </span>
      </span>
    ),
  }
}

function InputItemBody({ item, accent }: { item: ResponsesInputItem; accent: string }) {
  if (item.type === 'message') return <MessageBody item={item} accent={accent} />
  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    return <ToolOutputBody item={item} />
  }
  if (item.type === 'mcp_tool_call_output') return <McpOutputBody item={item} />
  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto opacity-70">
      {JSON.stringify(item, null, 2)}
    </pre>
  )
}

function MessageBody({ item, accent: _accent }: { item: ResponsesInputMessage; accent: string }) {
  if (!item.content?.length) {
    return <div className="text-muted-foreground italic px-2 py-1">(no content)</div>
  }
  return (
    <div className="flex flex-col gap-1.5">
      {item.content.map((c, i) => (
        <div key={i} className="max-h-80 overflow-auto">
          <ContentBlockView block={c} />
        </div>
      ))}
    </div>
  )
}

function ContentBlockView({ block }: { block: ResponsesContentItem }) {
  if (block.type === 'input_text' || block.type === 'output_text') {
    const text = (block as { text: string }).text
    return (
      <div className="rounded border border-[color:var(--llm)]/20 bg-[color:var(--llm)]/5 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[color:var(--llm)] mb-1 flex items-center gap-1.5">
          <span>{block.type === 'input_text' ? 'input_text' : 'output_text'}</span>
        </div>
        <div className="text-[12px] whitespace-pre-wrap break-words leading-relaxed">
          {text}
        </div>
      </div>
    )
  }
  if (block.type === 'input_image') {
    return (
      <div className="text-[11px] text-muted-foreground italic px-2 py-1">
        [input_image: {block.image_url.slice(0, 80)}{block.image_url.length > 80 ? '…' : ''}]
      </div>
    )
  }
  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words opacity-70 px-2 py-1">
      {JSON.stringify(block, null, 2)}
    </pre>
  )
}

function ToolOutputBody({
  item,
}: {
  item: ResponsesFunctionCallOutput | ResponsesCustomToolCallOutput
}) {
  return (
    <div className="rounded border border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[color:var(--tool)] mb-1 min-w-0">
        <Wrench className="w-3 h-3 shrink-0" />
        <span className="shrink-0">{item.type}</span>
        {(item as ResponsesCustomToolCallOutput).name && (
          <span className="font-mono normal-case text-foreground/90 shrink-0">
            {(item as ResponsesCustomToolCallOutput).name}
          </span>
        )}
        <span
          className="text-muted-foreground font-mono normal-case ml-auto truncate min-w-0"
          title={item.call_id}
        >
          {item.call_id}
        </span>
      </div>
      <ToolOutputContent output={item.output} />
    </div>
  )
}

function ToolOutputContent({ output }: { output: FunctionCallOutputPayload }) {
  if (typeof output === 'string') {
    return (
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto">
        {output}
      </pre>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {output.map((part, i) => {
        if (part.type === 'input_text') {
          return (
            <pre
              key={i}
              className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto"
            >
              {part.text}
            </pre>
          )
        }
        return (
          <div key={i} className="text-[11px] text-muted-foreground italic">
            [input_image: {part.image_url.slice(0, 80)}{part.image_url.length > 80 ? '…' : ''}]
          </div>
        )
      })}
    </div>
  )
}

function McpOutputBody({ item }: { item: ResponsesMcpToolCallOutput }) {
  return (
    <div className="rounded border border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[color:var(--tool)] mb-1">
        <Wrench className="w-3 h-3" />
        <span>mcp_tool_call_output</span>
        <span className="text-muted-foreground font-mono normal-case ml-auto">{item.call_id}</span>
      </div>
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto">
        {typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2)}
      </pre>
    </div>
  )
}

function InstructionsSection({ text }: { text: string }) {
  return (
    <Section
      title="instructions"
      icon={<FileCode2 className="w-3.5 h-3.5" />}
      summary={`${fmtChars(text.length)} chars`}
      defaultOpen={false}
    >
      <pre className="px-3 py-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/90 max-h-96 overflow-auto rounded border border-border/60 bg-background/40">
        {text}
      </pre>
    </Section>
  )
}

function ToolsSection({ tools }: { tools: unknown[] }) {
  return (
    <Section
      title="tools"
      icon={<Wrench className="w-3.5 h-3.5" />}
      summary={`${tools.length} tool${tools.length === 1 ? '' : 's'}`}
      defaultOpen={false}
    >
      <div className="flex flex-col gap-1">
        {tools.map((t: any, i) => {
          // Codex tool entries are loosely-typed (any shape OpenAI accepts).
          // Common case: `{type: "function", function: {name, description, parameters}}`
          // but we also see `{type: "custom", name, …}` and similar.
          const name =
            t?.function?.name ??
            t?.name ??
            (typeof t?.type === 'string' ? `(${t.type})` : `(tool ${i + 1})`)
          const description = t?.function?.description ?? t?.description
          return (
            <div key={i} className="rounded border border-border/60 bg-background/40 px-2 py-1.5">
              <div className="flex items-center gap-2 text-xs">
                <FileSearch className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="font-mono text-[color:var(--tool)] truncate">{name}</span>
                {description && (
                  <span className="text-muted-foreground text-[11px] line-clamp-1 ml-1">
                    {description}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

// ── helpers ────────────────────────────────────────────────────────────

function summariseItem(item: ResponsesInputItem): string {
  if (item.type === 'message') {
    for (const c of item.content ?? []) {
      if (c.type === 'input_text' || c.type === 'output_text') {
        const text = (c as { text: string }).text.replace(/\s+/g, ' ').trim()
        if (text) return text.slice(0, 120) + (text.length > 120 ? '…' : '')
      }
    }
    return `(${item.content?.length ?? 0} content blocks)`
  }
  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    if (typeof item.output === 'string') {
      const t = item.output.replace(/\s+/g, ' ').trim()
      return t.slice(0, 120) + (t.length > 120 ? '…' : '')
    }
    return `(${item.output.length} parts)`
  }
  return ''
}

function fmtChars(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
}

// Provided so InteractionCard can reuse a "Settings2" icon for header
// alignment if needed elsewhere.
export const __unused = Settings2
