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
        <p className="text-sm leading-relaxed">
          Run{' '}
          <code className="px-1.5 py-0.5 rounded bg-muted text-xs">
            ANTHROPIC_BASE_URL=http://{host} claude
          </code>{' '}
          in any terminal. Every API call goes through this proxy and shows up
          in the sidebar as a new project (one per cwd).
        </p>
      </div>
    </div>
  )
}
