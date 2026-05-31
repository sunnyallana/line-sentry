import React from 'react';
import { cn } from '../../lib/cn';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'outline';

const variants: Record<BadgeVariant, string> = {
  default: 'bg-primary/15 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  info: 'bg-info/15 text-info',
  muted: 'bg-muted text-muted-foreground',
  outline: 'border border-border text-foreground',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export const Badge = ({ className, variant = 'default', ...props }: BadgeProps) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
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
