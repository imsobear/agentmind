// Renders the "Action" step of the ReAct loop — the local tool execution
// that happens BETWEEN two LLM API calls. The producer iteration's
// `tool_use` blocks are paired with the consumer iteration's `tool_result`
// blocks by `tool_use_id`; the gap duration is the wall-clock the model
// never sees (Bash sleeps, large Reads, MCP roundtrips).

import { useState } from 'react'
import {
  Wrench,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Hourglass,
  CircleSlash,
  Image as ImageIcon,
  ArrowDownToLine,
  Cpu,
} from 'lucide-react'
import { Badge } from '#/components/ui/badge'
import { cn } from '#/lib/utils'
import { formatDuration } from '#/components/MessageDetail'
import type { ActionEntry, ActionSegment } from '#/lib/api'

export function ActionExecutionSegment({ segment }: { segment: ActionSegment }) {
  const [open, setOpen] = useState(true)
  const errorCount = segment.actions.filter((a) => a.isError).length
  const unmatchedCount = segment.actions.filter((a) => a.unmatched).length

  return (
    <div className="relative pl-6">
      {/* vertical rail from previous interaction card down to the next */}
      <div
        aria-hidden
        className="absolute left-2 top-0 bottom-0 w-px border-l-2 border-dashed border-[color:var(--tool)]/30"
      />
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative -ml-6 w-full min-w-0 flex flex-wrap items-center gap-2 pl-1 pr-2 py-1 text-left text-[11px] hover:text-foreground transition-colors group"
      >
        {/* node on the rail */}
        <span className="relative w-4 h-4 rounded-full bg-background border-2 border-[color:var(--tool)]/40 flex items-center justify-center shrink-0">
          {segment.pending ? (
            <Hourglass className="w-2.5 h-2.5 text-[color:var(--cc)] animate-pulse" />
          ) : (
            <Wrench className="w-2.5 h-2.5 text-[color:var(--tool)]" />
          )}
        </span>
        <span className="text-muted-foreground group-hover:text-foreground transition-colors flex items-center gap-1.5">
          {open ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          <span className="uppercase tracking-wider font-medium">
            Execute tools
          </span>
          <Badge
            variant="tool"
            className="!text-[10px] !py-0 gap-1 normal-case"
            title="Local tool execution by Claude Code — runs between two API calls, the model never sees this wall-clock cost"
          >
            <Cpu className="w-2.5 h-2.5" />
            local
          </Badge>
          <span className="normal-case tracking-normal">
            · {segment.actions.length} call{segment.actions.length === 1 ? '' : 's'}
          </span>
          {!segment.pending && segment.durationMs != null && (
            <span className="normal-case tracking-normal tabular-nums">
              · {formatDuration(segment.durationMs)}
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {errorCount > 0 && (
            <Badge variant="danger" className="!text-[10px] gap-1">
              <AlertCircle className="w-3 h-3" />
              {errorCount} error{errorCount === 1 ? '' : 's'}
            </Badge>
          )}
          {unmatchedCount > 0 && (
            <Badge variant="warn" className="!text-[10px] gap-1">
              <CircleSlash className="w-3 h-3" />
              {unmatchedCount} unmatched
            </Badge>
          )}
          {segment.pending && (
            <Badge variant="warn" className="!text-[10px]">
              in flight
            </Badge>
          )}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 mb-2 flex flex-col gap-1.5">
          {segment.actions.map((a) => (
            <ActionRow key={a.toolUseId} action={a} pending={!!segment.pending} />
          ))}
        </div>
      )}
    </div>
  )
}

function ActionRow({ action, pending }: { action: ActionEntry; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const isErr = action.isError
  const summary = oneLinerForInput(action.name, action.input)
  const status: StatusKind = action.unmatched
    ? 'unmatched'
    : pending
      ? 'pending'
      : isErr
        ? 'error'
        : 'ok'
  return (
    <div
      className={cn(
        // `min-w-0` ensures this row can shrink inside a constrained
        // pane; without it, the inner `truncate` span on the summary
        // never kicks in and a long Bash arg / file path runs off the
        // right edge.
        'rounded-md border bg-background/40 min-w-0',
        status === 'error' && 'border-destructive/40 bg-destructive/5',
        status === 'unmatched' && 'border-[color:var(--cc)]/40 bg-[color:var(--cc)]/5',
        status === 'pending' && 'border-[color:var(--cc)]/30 bg-[color:var(--cc)]/5',
        status === 'ok' && 'border-[color:var(--tool)]/25',
      )}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full min-w-0 flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="text-muted-foreground shrink-0">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </span>
        <Wrench className="w-3 h-3 text-[color:var(--tool)] shrink-0" />
        <span className="font-mono text-[11px] text-[color:var(--tool)] shrink-0">
          {action.name}
        </span>
        {summary && (
          <span
            className="text-[11px] text-foreground/80 font-mono truncate min-w-0 flex-1"
            title={summary}
          >
            {summary}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 shrink-0">
          {action.hasImage && (
            <Badge variant="info" className="!text-[10px] gap-1 shrink-0" title="result contained an image">
              <ImageIcon className="w-3 h-3" />
              img
            </Badge>
          )}
          {action.hasToolHydration && (
            <Badge variant="muted" className="!text-[10px] shrink-0" title="ToolSearch hydration block">
              hydrate
            </Badge>
          )}
          <StatusBadge status={status} />
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 pt-1 border-t border-border/40 flex flex-col gap-2">
          <Sub label="input">
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto bg-background/60 rounded p-2 border border-border/40">
              {tryStringify(action.input)}
            </pre>
          </Sub>
          {status === 'ok' || status === 'error' ? (
            <Sub label={isErr ? 'result · error' : 'result'}>
              {action.resultPreview != null && action.resultPreview.length > 0 ? (
                <pre
                  className={cn(
                    'text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto bg-background/60 rounded p-2 border',
                    isErr ? 'border-destructive/40' : 'border-border/40',
                  )}
                >
                  {action.resultPreview}
                </pre>
              ) : (
                <div className="text-[11px] text-muted-foreground italic">
                  (empty)
                </div>
              )}
              {action.resultTruncated && (
                <div className="text-[10px] text-muted-foreground italic flex items-center gap-1 mt-1">
                  <ArrowDownToLine className="w-3 h-3" />
                  Open the next iteration to see the full tool_result block.
                </div>
              )}
            </Sub>
          ) : status === 'unmatched' ? (
            <div className="text-[11px] text-[color:var(--cc)] italic">
              No matching tool_result in the next iteration — Claude Code
              dropped or skipped this call.
            </div>
          ) : (
            <div className="text-[11px] text-[color:var(--cc)] italic">
              Still in flight — no follow-up API call captured yet.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type StatusKind = 'ok' | 'error' | 'unmatched' | 'pending'

function StatusBadge({ status }: { status: StatusKind }) {
  if (status === 'error') {
    return (
      <Badge variant="danger" className="!text-[10px] gap-1">
        <AlertCircle className="w-3 h-3" />
        error
      </Badge>
    )
  }
  if (status === 'unmatched') {
    return (
      <Badge variant="warn" className="!text-[10px] gap-1">
        <CircleSlash className="w-3 h-3" />
        unmatched
      </Badge>
    )
  }
  if (status === 'pending') {
    return (
      <Badge variant="warn" className="!text-[10px] gap-1">
        <Hourglass className="w-3 h-3" />
        pending
      </Badge>
    )
  }
  // ok — no badge needed; the absence of any status flag is itself the
  // "completed successfully" signal, and a bare character count on the
  // right rail carried no semantic value.
  return null
}

function Sub({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

// Best-effort one-line summary of a tool call, keyed off conventional
// Claude Code tool shapes. Falls back to truncated JSON so we never lose
// information when a tool's input doesn't match.
function oneLinerForInput(name: string, input: unknown): string {
  if (input == null || typeof input !== 'object') {
    return tryStringify(input, 120)
  }
  const o = input as Record<string, unknown>
  const pick = (k: string) =>
    typeof o[k] === 'string' ? (o[k] as string) : undefined
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return pick('file_path') ?? pick('path') ?? compactJson(o)
    case 'Bash':
    case 'BashOutput':
      return pick('command') ?? pick('description') ?? compactJson(o)
    case 'Glob':
      return pick('pattern') ?? compactJson(o)
    case 'Grep': {
      const pat = pick('pattern')
      const path = pick('path')
      if (pat && path) return `${pat}  in ${path}`
      return pat ?? compactJson(o)
    }
    case 'WebFetch':
    case 'WebSearch':
      return pick('url') ?? pick('query') ?? pick('search_term') ?? compactJson(o)
    case 'Task': {
      // Subagent spawn — Claude Code's `Task` carries description + prompt.
      const desc = pick('description')
      const subagent = pick('subagent_type')
      if (desc) return subagent ? `${subagent}: ${desc}` : desc
      return compactJson(o)
    }
    case 'TodoWrite': {
      const todos = o.todos
      if (Array.isArray(todos)) return `${todos.length} todo${todos.length === 1 ? '' : 's'}`
      return compactJson(o)
    }
    // Codex CLI's canonical shell tool — input is `{command: string[],
    // workdir?, timeout_ms?}`. Show the command as a single line.
    case 'shell':
    case 'local_shell': {
      const cmd = o.command ?? (o as { action?: { command?: unknown } }).action?.command
      if (Array.isArray(cmd)) return cmd.map(String).join(' ')
      if (typeof cmd === 'string') return cmd
      return compactJson(o)
    }
    // Codex's `apply_patch` tool — input is a string (the patch body).
    // Show the first changed file path if we can spot it.
    case 'apply_patch': {
      const input = pick('input') ?? pick('patch')
      if (input) {
        const m = input.match(/\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)/i)
        if (m) return m[1].trim()
        return input.split('\n')[0]
      }
      return compactJson(o)
    }
    default:
      return compactJson(o)
  }
}

function compactJson(o: unknown): string {
  const s = tryStringify(o, 160)
  return s
}

function tryStringify(v: unknown, max = 200): string {
  let s: string
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    s = String(v)
  }
  if (s == null) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

