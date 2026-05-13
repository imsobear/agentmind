import { createFileRoute } from '@tanstack/react-router'
import { Inbox } from 'lucide-react'

export const Route = createFileRoute('/')({ component: Empty })

function Empty() {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      <div className="text-center max-w-md px-6">
        <Inbox className="w-10 h-10 mx-auto mb-4 opacity-50" />
        <div className="text-base font-medium text-foreground mb-2">No session selected</div>
        <p className="text-sm leading-relaxed">
          Run{' '}
          <code className="px-1.5 py-0.5 rounded bg-muted text-xs">
            ANTHROPIC_BASE_URL=http://127.0.0.1:8088 claude
          </code>{' '}
          in any terminal. Every API call goes through this proxy and shows up
          in the sidebar as a new session.
        </p>
      </div>
    </div>
  )
}
