import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Wrench,
  Database,
  Brain,
  Type,
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
  prevMessageCount?: number
}) {
  const req = interaction.request
  const sysBlocks = normalizeSystem(req.system)
  return (
    <div className="p-3 flex flex-col gap-3 text-xs">
      {/* Messages first — that's what the LLM is being asked to act on.
          All meta (model, max_tokens, streaming, temperature, thinking)
          is either on the iter header or available via raw JSON below. */}
      <MessagesSection messages={req.messages} prevMessageCount={prevMessageCount} />
      {sysBlocks.length > 0 && <SystemSection blocks={sysBlocks} />}
      {req.tools && req.tools.length > 0 && <ToolsSection tools={req.tools} />}
      <RawJsonToggle obj={req} label="raw request JSON" />
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

function MessagesSection({
  messages,
  prevMessageCount,
}: {
  messages: MessageParam[]
  prevMessageCount: number
}) {
  const newCount = Math.max(0, messages.length - prevMessageCount)
  // Glanceable preview text — first "new" user-typed text in this iter.
  // For iter 1 that's the prompt; for later iters it's usually a
  // tool_result so the preview falls back to "K new" instead.
  const preview = useMemo<string | undefined>(() => {
    for (let i = prevMessageCount; i < messages.length; i++) {
      const m = messages[i]
      if (m.role !== 'user') continue
      const t = userTextPreview(m)
      if (t) return t
    }
    return undefined
  }, [messages, prevMessageCount])

  const summary = (
    <>
      {messages.length} message{messages.length === 1 ? '' : 's'}
      {prevMessageCount > 0 && newCount > 0 && (
        <span className="ml-1 text-[color:var(--user)]">· {newCount} new</span>
      )}
      {prevMessageCount > 0 && (
        <span className="ml-1">· {prevMessageCount} inherited</span>
      )}
      {preview && (
        <span className="ml-2 italic text-foreground/70">· “{preview}”</span>
      )}
    </>
  )

  return (
    <Section
      title="messages"
      icon={<Database className="w-3.5 h-3.5" />}
      summary={summary}
      defaultOpen={false}
    >
      <div className="flex flex-col gap-1.5">
        {messages.map((m, i) => (
          <MessageRow
            key={i}
            m={m}
            index={i}
            inherited={i < prevMessageCount}
            isLastInherited={i === prevMessageCount - 1 && newCount > 0}
          />
        ))}
      </div>
    </Section>
  )
}

function MessageRow({
  m,
  index,
  inherited,
  isLastInherited,
}: {
  m: MessageParam
  index: number
  inherited: boolean
  isLastInherited: boolean
}) {
  // Inherited messages start collapsed (they're context from prior iters
  // and rarely need re-reading); new messages start expanded.
  const [open, setOpen] = useState(!inherited)
  const blocks: ContentBlock[] = typeof m.content === 'string'
    ? [{ type: 'text', text: m.content }]
    : m.content

  const inlineSummary = useMemo(() => oneLineMessageSummary(blocks), [blocks])

  return (
    <>
      <div
        className={cn(
          'rounded border bg-background/40 transition-opacity',
          m.role === 'user'
            ? 'border-[color:var(--user)]/30'
            : 'border-[color:var(--llm)]/30',
          inherited && 'opacity-50 hover:opacity-100',
        )}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-muted/30 transition-colors"
        >
          <span className="text-muted-foreground shrink-0">
            {open ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
          <span
            className={cn(
              'text-[10px] uppercase tracking-wider font-medium shrink-0',
              m.role === 'user'
                ? 'text-[color:var(--user)]'
                : 'text-[color:var(--llm)]',
            )}
          >
            {m.role}
          </span>
          <span className="text-muted-foreground text-[10px] tabular-nums shrink-0 font-mono">
            #{index + 1}
          </span>
          <span className="text-muted-foreground text-[10px] shrink-0">
            {blocks.length}b
          </span>
          {!open && (
            <span className="text-foreground/70 text-[11px] truncate min-w-0 italic">
              {inlineSummary}
            </span>
          )}
          {inherited ? (
            <Badge
              variant="muted"
              className="ml-auto !text-[10px] !py-0 shrink-0"
              title="Identical to a message already present in the previous iteration"
            >
              inherited
            </Badge>
          ) : (
            <Badge
              variant="success"
              className="ml-auto !text-[10px] !py-0 shrink-0"
              title="Appended to messages[] between this iter and the previous one"
            >
              new
            </Badge>
          )}
        </button>
        {open && (
          <div className="px-2 py-2 border-t border-border/40 flex flex-col gap-1.5">
            {blocks.map((b, i) => (
              <div key={i} className="flex gap-2 items-start">
                <span className="text-[10px] text-muted-foreground font-mono tabular-nums mt-1 shrink-0 w-8 text-right">
                  {index + 1}.{i + 1}
                </span>
                {/* Cap each block so an oversized text/thinking/tool_result
                    body scrolls inside its own row instead of pushing the
                    iter card off-screen. Chrome scrolls with content —
                    not ideal but the alternative (sticky chrome over a
                    nested scroll region) is fiddly across block kinds. */}
                <div className="flex-1 min-w-0 max-h-80 overflow-auto">
                  <ContentBlockView block={b} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {isLastInherited && (
        <div className="flex items-center gap-2 -my-0.5 px-1 text-[10px] uppercase tracking-wider text-[color:var(--user)]/70">
          <span className="flex-1 h-px bg-[color:var(--user)]/30" />
          <span>new in this iter</span>
          <span className="flex-1 h-px bg-[color:var(--user)]/30" />
        </div>
      )}
    </>
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

function userTextPreview(m: MessageParam): string | undefined {
  if (typeof m.content === 'string') {
    const stripped = stripSystemReminder(m.content).trim()
    return stripped ? truncate(stripped, 100) : undefined
  }
  for (const b of m.content) {
    if (b.type === 'text') {
      const stripped = stripSystemReminder(b.text).trim()
      if (stripped) return truncate(stripped, 100)
    }
  }
  return undefined
}

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
  title: string
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
          <span className="min-w-0 truncate normal-case tracking-normal text-muted-foreground/80">
            · {summary}
          </span>
        )}
      </button>
      {open && <div className="mt-2 ml-1">{children}</div>}
    </div>
  )
}

export function RawJsonToggle({ obj, label }: { obj: unknown; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span className="uppercase tracking-wider">{label}</span>
      </button>
      {open && (
        <pre className="mt-2 text-[10px] font-mono whitespace-pre-wrap break-words max-h-96 overflow-auto bg-background/60 rounded p-2 border border-border/40">
          {JSON.stringify(obj, null, 2)}
        </pre>
      )}
    </div>
  )
}
