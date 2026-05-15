import { useEffect, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Activity, Circle } from 'lucide-react'
import { api, subscribeEvents, type ProjectListItem } from '#/lib/api'
import { cn } from '#/lib/utils'
import { formatDistanceToNowStrict } from 'date-fns'
import { ScrollArea } from '#/components/ui/scroll-area'

export function ProjectsSidebar() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { location } = useRouterState()
  const activePid = location.pathname.match(/\/projects\/([^/]+)/)?.[1]

  async function reload() {
    try {
      const list = await api.listProjects()
      setProjects(list)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  useEffect(() => {
    reload()
    const interval = setInterval(reload, 5000)
    const stop = subscribeEvents(() => reload())
    return () => {
      clearInterval(interval)
      stop()
    }
  }, [])

  if (error) {
    return (
      <div className="p-4 text-xs text-destructive">
        Failed to load projects: {error}
      </div>
    )
  }

  if (projects === null) {
    return <div className="p-4 text-xs text-muted-foreground">Loading…</div>
  }

  if (projects.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        No captured projects yet.
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-2 flex flex-col gap-0.5">
        {projects.map((p) => (
          <ProjectRow key={p.projectId} p={p} active={p.projectId === activePid} />
        ))}
      </div>
    </ScrollArea>
  )
}

function ProjectRow({ p, active }: { p: ProjectListItem; active: boolean }) {
  const time = p.startedAt ? new Date(p.startedAt) : new Date(p.mtime)
  return (
    <Link
      to="/projects/$pid"
      params={{ pid: p.projectId }}
      className={cn(
        'flex flex-col gap-1 px-3 py-2 rounded-md text-xs',
        'hover:bg-muted/60 transition-colors',
        active && 'bg-muted',
      )}
    >
      <div className="flex items-center gap-2">
        {p.isLive ? (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[color:var(--user)] opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[color:var(--user)]" />
          </span>
        ) : (
          <Circle className="w-2 h-2 opacity-30 fill-current" />
        )}
        <span className="font-medium text-foreground truncate">
          {p.cwd ? lastPathSeg(p.cwd) : p.projectId.slice(0, 8)}
        </span>
        {p.agentType && (
          // Both agents get a coloured tag so a mixed sidebar is
          // scannable at a glance. The tag uses the agent's brand tint
          // (claude=peach for Anthropic's warm palette, codex=lavender
          // for the OpenAI side), kept low-chroma so it never
          // out-competes the `live` pulse or an error badge.
          <AgentBadge agent={p.agentType} />
        )}
        <span className="text-muted-foreground ml-auto tabular-nums">
          {formatDistanceToNowStrict(time, { addSuffix: false })}
        </span>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground tabular-nums">
        <span>{p.messageCount} msg</span>
        <span>·</span>
        <span>{p.interactionCount} call</span>
        {p.tokens.input + p.tokens.output > 0 && (
          <>
            <span>·</span>
            <span title="input → output tokens">
              {formatTokens(p.tokens.input)}→{formatTokens(p.tokens.output)}
            </span>
          </>
        )}
        {p.isLive && (
          <span className="ml-auto flex items-center gap-1 text-[color:var(--user)]">
            <Activity className="w-3 h-3" />
            live
          </span>
        )}
      </div>
      {p.cwd && (
        <div className="text-[10px] text-muted-foreground truncate font-mono opacity-70">
          {p.cwd}
        </div>
      )}
    </Link>
  )
}

function AgentBadge({ agent }: { agent: string }) {
  const colorVar =
    agent === 'codex-cli'
      ? 'var(--agent-codex)'
      : agent === 'claude-code'
        ? 'var(--agent-claude)'
        : undefined
  return (
    <span
      className="text-[9px] uppercase tracking-wider font-mono rounded px-1 py-0 shrink-0 border"
      style={
        colorVar
          ? {
              color: colorVar,
              borderColor: `color-mix(in oklab, ${colorVar} 40%, transparent)`,
              backgroundColor: `color-mix(in oklab, ${colorVar} 10%, transparent)`,
            }
          : undefined
      }
      title={agentTooltip(agent)}
    >
      {agentShortLabel(agent)}
    </span>
  )
}

function agentShortLabel(a: string): string {
  if (a === 'codex-cli') return 'codex'
  if (a === 'claude-code') return 'claude'
  return a
}

function agentTooltip(a: string): string {
  if (a === 'codex-cli') return 'Captured via OpenAI Responses API (Codex CLI)'
  if (a === 'claude-code') return 'Captured via Anthropic Messages API (Claude Code)'
  return a
}

function lastPathSeg(p: string): string {
  // Split on both `/` and `\` so Windows cwds (`C:\Users\foo\proj`)
  // render their basename rather than dumping the entire path.
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}
