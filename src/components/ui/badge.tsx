import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '#/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums border',
  {
    variants: {
      variant: {
        default: 'bg-muted text-foreground border-border',
        muted: 'bg-transparent text-muted-foreground border-border/60',
        outline: 'bg-transparent text-foreground border-border',
        success: 'bg-[color:var(--user)]/15 text-[color:var(--user)] border-[color:var(--user)]/40',
        info: 'bg-[color:var(--llm)]/15 text-[color:var(--llm)] border-[color:var(--llm)]/40',
        tool: 'bg-[color:var(--tool)]/15 text-[color:var(--tool)] border-[color:var(--tool)]/40',
        thinking: 'bg-[color:var(--thinking)]/15 text-[color:var(--thinking)] border-[color:var(--thinking)]/40',
        warn: 'bg-[color:var(--cc)]/15 text-[color:var(--cc)] border-[color:var(--cc)]/40',
        danger: 'bg-destructive/15 text-destructive border-destructive/40',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
