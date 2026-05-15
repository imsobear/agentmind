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
      <div className="text-center max-w-lg px-6">
        <Inbox className="w-10 h-10 mx-auto mb-4 opacity-50" />
        <div className="text-base font-medium text-foreground mb-2">No project selected</div>
        <p className="text-sm leading-relaxed mb-3">
          Point any supported agent at this proxy. Every API call shows up
          in the sidebar as a new project (one per cwd).
        </p>
        <div className="flex flex-col gap-1.5 text-xs text-left">
          <div className="flex items-baseline gap-2">
            <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground/80 w-14 shrink-0">
              Claude
            </span>
            <code className="px-1.5 py-0.5 rounded bg-muted truncate">
              ANTHROPIC_BASE_URL=http://{host} claude
            </code>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground/80 w-14 shrink-0">
              Codex
            </span>
            <code className="px-1.5 py-0.5 rounded bg-muted truncate">
              OPENAI_BASE_URL=http://{host}/v1 codex
            </code>
          </div>
        </div>
      </div>
    </div>
  )
}
