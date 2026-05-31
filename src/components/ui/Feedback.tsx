import React from 'react';
import { cn } from '../../lib/cn';

export const Spinner = ({ className }: { className?: string }) => (
  <span
    role="status"
    aria-label="Loading"
    className={cn(
      'inline-block h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent text-primary',
      className,
    )}
  />
);

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn('animate-pulse rounded-md bg-muted', className)} />
);

/** Centered full-area loading state (route/page level). */
export const PageLoader = ({ label }: { label?: string }) => (
  <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
    <Spinner className="h-8 w-8" />
    {label && <p className="text-sm text-muted-foreground">{label}</p>}
  </div>
);

/** Empty-state placeholder. */
export const EmptyState = ({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) => (
  <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
    {icon && <div className="text-muted-foreground">{icon}</div>}
    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);
