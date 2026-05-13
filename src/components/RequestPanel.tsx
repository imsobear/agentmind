import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Wrench,
  Brain,
  Type,
  User,
  Bot,
} from 'lucide-react'
import type { InteractionFull } from '#/lib/api'
import type { MessageParam, ToolDefinition, SystemBlock, ContentBlock } from '#/lib/anthropic-types'
import { Badge } from '#/components/ui/badge'
import { cn } from '#/lib/utils'

export function RequestPanel({
  interaction,
  prevMessageCount = 0,
}: {
  interaction: InteractionFull
  // Count of leading messages this iter inherited verbatim from the
  // previous iter — drives the per-message `new` badge so the eye can
  // immediately spot what changed between consecutive LLM calls.
  prevMessageCount?: number
}) {
  const req = interaction.request
  const sysBlocks = normalizeSystem(req.system)
  return (
    // All four kinds of "what was sent" — each message, the system
    // prompt, the tool definitions — render as flat sibling sections
    // under this column so the information hierarchy stays one level
    // deep and consistent.
    <div className="p-3 flex flex-col gap-2 text-xs">
      {req.messages.map((m, i) => (
        <MessageSection
          key={i}
          m={m}
          isNew={i >= prevMessageCount && prevMessageCount > 0}
        />
      ))}
      {sysBlocks.length > 0 && <SystemSection blocks={sysBlocks} />}
      {req.tools && req.tools.length > 0 && <ToolsSection tools={req.tools} />}
    </div>
  )
}

function MessageSection({
  m,
  isNew,
}: {
  m: MessageParam
  isNew: boolean
}) {
  const blocks: ContentBlock[] = typeof m.content === 'string'
    ? [{ type: 'text', text: m.content }]
    : m.content
  const inlineSummary = useMemo(() => oneLineMessageSummary(blocks), [blocks])
  const isUser = m.role === 'user'

  const title = (
    <span className="flex items-baseline gap-0.5">
      <span>messages</span>
      <span
        className={cn(
          'font-mono',
          isUser ? 'text-[color:var(--user)]' : 'text-[color:var(--llm)]',
        )}
      >
        #{m.role}
      </span>
    </span>
  )

  const summary = (
    <>
      {inlineSummary && (
        <span className="italic text-foreground/70 truncate flex-1 min-w-0">
          “{inlineSummary}”
        </span>
      )}
      {isNew && (
        <Badge
          variant="success"
          className="ml-auto !text-[10px] !py-0 shrink-0"
          title="Appended to messages[] between this iter and the previous one"
        >
          new
        </Badge>
      )}
    </>
  )

  return (
    <Section
      title={title}
      icon={isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
      summary={summary}
      defaultOpen={false}
    >
      <NumberedBlocks blocks={blocks} />
    </Section>
  )
}

function NumberedBlocks({ blocks }: { blocks: ContentBlock[] }) {
  if (!blocks.length) {
    return <div className="text-muted-foreground italic px-2 py-1">(no blocks)</div>
  }
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((b, i) => (
        // Cap each block so oversized text/thinking/tool_result bodies
        // scroll inside the row rather than pushing the iter card off
        // the screen. No leading numeric gutter — every block kind
        // already carries its own coloured chrome (text / thinking /
        // tool_use / tool_result) so the ordinal index added nothing.
        <div key={i} className="max-h-80 overflow-auto">
          <ContentBlockView block={b} />
        </div>
      ))}
    </div>
  )
}

function normalizeSystem(sys: undefined | string | SystemBlock[]): SystemBlock[] {
  if (!sys) return []
  if (typeof sys === 'string') return [{ type: 'text', text: sys }]
  return sys
}

function SystemSection({ blocks }: { blocks: SystemBlock[] }) {
  return (
    <Section
      title="system prompt"
      icon={<FileCode2 className="w-3.5 h-3.5" />}
      summary={`${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${fmtChars(totalChars(blocks))} chars`}
      defaultOpen={false}
    >
      <div className="flex flex-col gap-2">
        {blocks.map((b, i) => (
          <div
            key={i}
            className={cn(
              'rounded border border-border/60 bg-background/40',
              b.cache_control && 'border-[color:var(--cc)]/40',
            )}
          >
            <div className="px-2 py-1 text-[10px] border-b border-border/40 text-muted-foreground flex items-center gap-2">
              <span>block {i + 1}</span>
              <span>{b.text.length.toLocaleString()} chars</span>
              {b.cache_control && (
                <Badge variant="warn" className="ml-auto !py-0">
                  cache: {b.cache_control.type}
                </Badge>
              )}
            </div>
            <pre className="px-3 py-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/90 max-h-96 overflow-auto">
              {b.text}
            </pre>
          </div>
        ))}
      </div>
    </Section>
  )
}

function ToolsSection({ tools }: { tools: ToolDefinition[] }) {
  return (
    <Section
      title="tools"
      icon={<Wrench className="w-3.5 h-3.5" />}
      summary={`${tools.length} tool${tools.length === 1 ? '' : 's'} sent with full JSON Schema`}
      defaultOpen={false}
    >
      <div className="flex flex-col gap-1">
        {tools.map((t, i) => (
          <ToolRow key={i} tool={t} />
        ))}
      </div>
    </Section>
  )
}

function ToolRow({ tool }: { tool: ToolDefinition }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded border border-border/60 bg-background/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/30"
      >
        <span className="text-muted-foreground">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        <span className="font-mono text-[color:var(--tool)] text-xs">{tool.name}</span>
        {tool.description && (
          <span className="text-muted-foreground text-[11px] line-clamp-1 ml-1">
            {tool.description}
          </span>
        )}
        {tool.cache_control && (
          <Badge variant="warn" className="ml-auto !py-0 !text-[10px]">
            cache
          </Badge>
        )}
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-border/40">
          {tool.description && (
            <div className="text-[11px] text-muted-foreground mb-2 whitespace-pre-wrap">
              {tool.description}
            </div>
          )}
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-96 overflow-auto bg-background/60 rounded p-2 border border-border/40">
            {JSON.stringify(tool.input_schema, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

export function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === 'text') {
    return (
      <div className="rounded border border-[color:var(--llm)]/20 bg-[color:var(--llm)]/5 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[color:var(--llm)] mb-1 flex items-center gap-1.5">
          <Type className="w-3 h-3" />
          <span>text</span>
          {block.cache_control && (
            <Badge variant="warn" className="ml-auto !py-0 !text-[10px]">
              cache
            </Badge>
          )}
        </div>
        <div className="text-[12px] whitespace-pre-wrap break-words leading-relaxed">
          {block.text}
        </div>
      </div>
    )
  }
  if (block.type === 'thinking') {
    return (
      <div className="rounded border border-[color:var(--thinking)]/30 bg-[color:var(--thinking)]/5 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[color:var(--thinking)] mb-1 flex items-center gap-1.5">
          <Brain className="w-3 h-3" />
          <span>thinking</span>
        </div>
        <div className="text-[12px] whitespace-pre-wrap break-words leading-relaxed">
          {block.thinking}
        </div>
      </div>
    )
  }
  if (block.type === 'redacted_thinking') {
    return (
      <div className="rounded border border-[color:var(--thinking)]/30 bg-[color:var(--thinking)]/5 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[color:var(--thinking)] mb-1 flex items-center gap-1.5">
          <Brain className="w-3 h-3" />
          <span>thinking · redacted</span>
        </div>
        <div className="text-[11px] text-muted-foreground italic">
          {block.data.length} bytes encrypted
        </div>
      </div>
    )
  }
  if (block.type === 'tool_use') {
    return (
      <div className="rounded border border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5 px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[color:var(--tool)] mb-1">
          <Wrench className="w-3 h-3" />
          <span>tool_use</span>
          <span className="font-mono normal-case text-foreground/90">{block.name}</span>
          <span className="text-muted-foreground font-mono normal-case ml-auto">
            {block.id}
          </span>
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto bg-background/60 rounded p-2 border border-border/40">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    )
  }
  if (block.type === 'tool_result') {
    const isErr = block.is_error === true
    return (
      <div
        className={cn(
          'rounded border px-2 py-1.5',
          isErr
            ? 'border-destructive/40 bg-destructive/5'
            : 'border-[color:var(--tool)]/30 bg-[color:var(--tool)]/5',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-1.5 text-[10px] uppercase tracking-wider mb-1',
            isErr ? 'text-destructive' : 'text-[color:var(--tool)]',
          )}
        >
          <Wrench className="w-3 h-3" />
          <span>{isErr ? 'tool_error' : 'tool_result'}</span>
          <span className="text-muted-foreground font-mono normal-case ml-auto">
            {block.tool_use_id}
          </span>
          {block.cache_control && (
            <Badge variant="warn" className="!py-0 !text-[10px]">
              cache
            </Badge>
          )}
        </div>
        {typeof block.content === 'string' ? (
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto">
            {block.content}
          </pre>
        ) : Array.isArray(block.content) ? (
          <div className="flex flex-col gap-1">
            {block.content.map((sub: any, i) => {
              if (sub == null) return null
              if (typeof sub === 'string') {
                return (
                  <pre key={i} className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto">
                    {sub}
                  </pre>
                )
              }
              if (sub.type === 'text') {
                return (
                  <pre key={i} className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto">
                    {sub.text}
                  </pre>
                )
              }
              if (sub.type === 'image') {
                return (
                  <div key={i} className="text-[11px] text-muted-foreground italic">
                    [image: {sub.source?.type ?? 'unknown'}]
                  </div>
                )
              }
              if (sub.type === 'tool_reference') {
                // Anthropic's ToolSearch returns these to hydrate deferred
                // tool schemas into the cached prefix. They look like
                // {type:"tool_reference", tool_name:"..."} — render as a chip.
                return (
                  <Badge key={i} variant="tool" className="self-start !text-[10px]">
                    hydrate {sub.tool_name}
                  </Badge>
                )
              }
              return (
                <pre key={i} className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto opacity-70">
                  {JSON.stringify(sub, null, 2)}
                </pre>
              )
            })}
          </div>
        ) : (
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto opacity-70">
            {JSON.stringify(block.content, null, 2)}
          </pre>
        )}
      </div>
    )
  }
  if (block.type === 'image') {
    return (
      <div className="text-[11px] text-muted-foreground italic">
        [image: {block.source.type}]
      </div>
    )
  }
  return null
}

// ── helpers ────────────────────────────────────────────────────────────

function oneLineMessageSummary(blocks: ContentBlock[]): string {
  if (!blocks.length) return '(empty)'
  // Prefer a meaningful text line.
  for (const b of blocks) {
    if (b.type === 'text') {
      const t = stripSystemReminder(b.text).trim()
      if (t) return truncate(t, 120)
    }
  }
  // Otherwise summarise by kind: "tool_result ×3", "tool_use Read"…
  const counts = new Map<string, number>()
  let firstToolUseName: string | undefined
  for (const b of blocks) {
    counts.set(b.type, (counts.get(b.type) ?? 0) + 1)
    if (b.type === 'tool_use' && !firstToolUseName) firstToolUseName = b.name
  }
  const parts: string[] = []
  for (const [k, n] of counts) {
    if (k === 'tool_use' && firstToolUseName) {
      parts.push(`${k}: ${firstToolUseName}${n > 1 ? ` ×${n}` : ''}`)
    } else if (n > 1) {
      parts.push(`${k} ×${n}`)
    } else {
      parts.push(k)
    }
  }
  return parts.join(' · ')
}

function stripSystemReminder(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1).trimEnd() + '…'
}

function totalChars(blocks: { text: string }[]): number {
  return blocks.reduce((acc, b) => acc + b.text.length, 0)
}

function fmtChars(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
}

export function Section({
  title,
  icon,
  summary,
  defaultOpen,
  children,
}: {
  title: React.ReactNode
  icon?: React.ReactNode
  summary?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="shrink-0">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="font-medium shrink-0">{title}</span>
        {summary != null && (
          <span className="flex-1 min-w-0 flex items-center gap-1 normal-case tracking-normal text-muted-foreground/80">
            <span className="shrink-0">·</span>
            {summary}
          </span>
        )}
      </button>
      {open && <div className="mt-2 ml-1">{children}</div>}
    </div>
  )
}

