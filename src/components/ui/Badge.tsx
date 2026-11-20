import React from 'react';
import { cn } from '../../lib/cn';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'outline';

const variants: Record<BadgeVariant, string> = {
  default: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-info/10 text-info',
  muted: 'bg-muted text-muted-foreground',
  outline: 'border border-border text-foreground',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export const Badge = ({ className, variant = 'default', ...props }: BadgeProps) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 py-0.5 text-xs font-medium',
      variants[variant],
      className,
    )}
    {...props}
  />
);

/** Map a machine status to a badge variant + label. */
export function machineStatusBadge(status: string): { variant: BadgeVariant; label: string } {
  switch (status) {
    case 'running':
      return { variant: 'success', label: 'Running' };
    case 'stoppage':
      return { variant: 'danger', label: 'Stoppage' };
    case 'stopped_yet_producing':
      return { variant: 'warning', label: 'Stopped (producing)' };
    default:
      return { variant: 'muted', label: 'Inactive' };
  }
}
