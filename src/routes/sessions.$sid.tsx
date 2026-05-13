import { createFileRoute, Outlet } from '@tanstack/react-router'

// Pass-through layout: the actual rendering happens in the right pane
// (rendered via the root <Outlet />). Middle pane reads :sid from URL.
export const Route = createFileRoute('/sessions/$sid')({
  component: () => <Outlet />,
})
