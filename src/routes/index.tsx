import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Inbox } from 'lucide-react'

export const Route = createFileRoute('/')({ component: Empty })

// `127.0.0.1:8088` is the SSR-time fallback so the rendered HTML is
// stable across runs (no hydration mismatch). The `useEffect` below
// upgrades to the real `window.location.host` once we have it, so a
// user running `agentmind-cli --port 9000` sees the right snippet.
const FALLBACK_HOST = '127.0.0.1:8088'

function Empty() {
  const [host, setHost] = useState(FALLBACK_HOST)
  useEffect(() => {
    if (typeof window !== 'undefined') setHost(window.location.host)
  }, [])
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      <div className="text-center max-w-md px-6">
        <Inbox className="w-10 h-10 mx-auto mb-4 opacity-50" />
        <div className="text-base font-medium text-foreground mb-2">No project selected</div>
        <p className="text-sm leading-relaxed mb-4">
          Launch your agent from AgentMind and every API call lands here
          as a new project (one per cwd).
        </p>
        <div className="flex flex-col gap-2 text-xs text-left">
          <div>
            <div className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground/80 mb-1">
              Claude Code
            </div>
            <code className="block px-2 py-1.5 rounded bg-muted">
              agentmind-cli claude
            </code>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground/80 mb-1">
              Codex CLI
            </div>
            <code className="block px-2 py-1.5 rounded bg-muted">
              agentmind-cli codex
            </code>
          </div>
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground/70 leading-relaxed">
          AgentMind injects the right env / config so the agent talks to
          this proxy automatically — no setup, nothing to clean up.
          Or start your own agent and point it at{' '}
          <code className="font-mono">http://{host}</code>; see{' '}
          <a
            className="underline hover:text-foreground"
            href="https://github.com/imsobear/agentmind#manual-setup"
            target="_blank"
            rel="noreferrer"
          >
            manual setup
          </a>
          .
        </p>
      </div>
    </div>
  )
}
