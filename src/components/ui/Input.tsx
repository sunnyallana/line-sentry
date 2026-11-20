import React from 'react';
import { cn } from '../../lib/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Optional leading icon (e.g. a lucide icon element). */
  icon?: React.ReactNode;
}

/* Shared look of text fields and selects. Focus shows as a coloured border
   with a soft halo, so the field keeps its size and nothing around it moves. */
const field = [
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm text-foreground',
  'transition-[border-color,box-shadow] duration-150 ease-out',
  'hover:border-foreground/30',
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20 focus-visible:ring-offset-0',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, icon, ...props }, ref) => (
    <div className="relative">
      {icon && (
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
          {icon}
        </span>
      )}
      <input
        ref={ref}
        className={cn(
          field,
          'placeholder:text-muted-foreground/80',
          icon && 'pl-9',
          className,
        )}
        {...props}
      />
    </div>
  ),
);
Input.displayName = 'Input';

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('mb-1.5 block text-[13px] font-medium text-foreground', className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        field,
        'select-chevron appearance-none pr-9',
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';
