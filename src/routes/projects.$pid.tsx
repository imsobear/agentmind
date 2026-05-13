import { createFileRoute, Outlet } from '@tanstack/react-router'

// Pass-through layout: the actual rendering happens in the right pane
// (rendered via the root <Outlet />). Middle pane reads :pid from URL.
export const Route = createFileRoute('/projects/$pid')({
  component: () => <Outlet />,
})
