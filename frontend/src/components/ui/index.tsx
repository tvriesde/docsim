import { Slot } from '@radix-ui/react-slot'
import * as SliderPrimitive from '@radix-ui/react-slider'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-accent text-white hover:bg-accent/90 shadow-[0_0_0_1px_rgb(255_255_255/0.08)_inset]',
        secondary: 'bg-panel-2 text-fg border border-border hover:bg-border/60',
        ghost: 'text-muted hover:text-fg hover:bg-panel-2',
        danger: 'bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-xs',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl border border-border bg-panel shadow-sm', className)} {...props} />
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center justify-between gap-3 border-b border-border px-5 py-3.5', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />
}

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', {
  variants: {
    tone: {
      neutral: 'bg-panel-2 text-muted border border-border',
      success: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/25',
      warning: 'bg-amber-500/10 text-amber-300 border border-amber-500/25',
      danger: 'bg-rose-500/10 text-rose-300 border border-rose-500/25',
      info: 'bg-sky-500/10 text-sky-300 border border-sky-500/25',
      accent: 'bg-accent/15 text-violet-200 border border-accent/30',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-border bg-panel-2 px-3 text-sm text-fg placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50',
        className,
      )}
      {...props}
    />
  )
}

export function Slider({ className, ...props }: ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root className={cn('relative flex h-5 w-full touch-none select-none items-center', className)} {...props}>
      <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-border">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-4 rounded-full border-2 border-accent bg-fg shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50" />
    </SliderPrimitive.Root>
  )
}

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-panel-2 transition-colors data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-fg shadow transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  )
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-md border border-border bg-panel-2 px-2.5 py-1.5 text-xs text-fg shadow-lg"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-border', className)}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-500"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block size-4 animate-spin rounded-full border-2 border-muted/40 border-t-accent', className)} />
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      {icon && <div className="rounded-xl border border-border bg-panel-2 p-3 text-muted">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  )
}
