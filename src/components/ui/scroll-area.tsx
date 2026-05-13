import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { cn } from '#/lib/utils'

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      {/*
        Radix's ScrollArea wraps children in an internal
        <div style="display: table; min-width: 100%"> so its scrollbars
        can measure horizontal overflow. The `display: table` part is
        what breaks us: a table sizes to its content (max-content), so
        any unbreakable long string inside — a long Bash arg, an
        absolute path, a tool_use id — pushes the wrapper wider than
        the visible viewport, and `<main className="overflow-hidden">`
        silently clips the rest off the right edge.

        We only ever want VERTICAL scrolling here, so we override the
        wrapper to `block` (inherits 100% of the viewport width) and
        force `min-width: 0` so children with their own `min-w-0` can
        actually shrink and truncate as designed.
      */}
      <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit] [&>div]:!block [&>div]:!min-w-0">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none transition-colors p-px"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

export { ScrollArea }
