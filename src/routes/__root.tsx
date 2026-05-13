import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'
import { SessionsSidebar } from '#/components/SessionsSidebar'
import { MessagesPane } from '#/components/MessagesPane'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'claude-proxy — local Claude Code traffic inspector' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: ThreePaneShell,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function ThreePaneShell() {
  return (
    <div className="flex h-dvh w-dvw overflow-hidden bg-background text-foreground">
      <aside className="w-[280px] shrink-0 border-r border-border flex flex-col">
        <Header />
        <SessionsSidebar />
      </aside>
      <section className="w-[340px] shrink-0 border-r border-border flex flex-col">
        <MessagesPane />
      </section>
      <main className="flex-1 min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}

function Header() {
  return (
    <div className="px-4 py-3 border-b border-border">
      <div className="font-medium text-sm tracking-tight">claude-proxy</div>
      <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
        ANTHROPIC_BASE_URL=http://127.0.0.1:8088
      </div>
    </div>
  )
}
