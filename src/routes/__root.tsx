import { Github } from 'lucide-react'
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'
import { SessionsSidebar } from '#/components/SessionsSidebar'
import { MessagesPane } from '#/components/MessagesPane'

const REPO_URL = 'https://github.com/imsobear/claude-proxy-console'

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
  // Fixed min-h on the header containers (matched in MessagesPane) is
  // what actually locks the left and middle columns to the same
  // baseline. Once height is structural we're free to pick whatever
  // typography reads best per column without re-creating the alignment
  // bug every time one of them changes.
  return (
    <div className="px-4 border-b border-border min-h-[60px] flex flex-col justify-center">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-sm tracking-tight">claude-proxy</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="View claude-proxy on GitHub"
          title="View claude-proxy on GitHub"
          className="text-muted-foreground hover:text-foreground transition-colors leading-none"
        >
          <Github className="w-3.5 h-3.5" />
        </a>
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">
        Local Claude Code traffic inspector
      </div>
    </div>
  )
}
