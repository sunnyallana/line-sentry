import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

/* Page-level building blocks. Every screen is made of the same few parts, so a
   person who has learned one screen already knows where things are on the next:
   title top-left, the one main action top-right, filters above the data. */

/** Title, one line of context, and the page's actions. */
export const PageHeader = ({
  title,
  description,
  actions,
  onBack,
  backLabel = 'Back',
  meta,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions; put the primary action last. */
  actions?: React.ReactNode;
  onBack?: () => void;
  backLabel?: string;
  /** Inline detail shown beside the title, e.g. a status. */
  meta?: React.ReactNode;
}) => (
  <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
    <div className="flex min-w-0 items-start gap-2">
      {onBack && (
        <Button variant="ghost" size="icon" className="-ml-2 mt-0.5 h-8 w-8 shrink-0" onClick={onBack} aria-label={backLabel} title={backLabel}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
      )}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="truncate text-2xl font-semibold leading-8 text-foreground">{title}</h1>
          {meta}
        </div>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

/** A titled panel. Tables and lists sit flush inside it (`flush`). */
export const Section = ({
  title,
  description,
  actions,
  children,
  flush,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** No body padding: for tables and lists that draw their own rows. */
  flush?: boolean;
  className?: string;
}) => (
  <section className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
    {(title || actions) && (
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-3">
        <div className="min-w-0">
          {title && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
    )}
    <div className={cn(!flush && 'p-5')}>{children}</div>
  </section>
);

/** Filters on the left, in reading order; nothing here changes data. */
export const Toolbar = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
);

type Tone = 'neutral' | 'good' | 'warn' | 'bad';

const toneText: Record<Tone, string> = {
  neutral: 'text-foreground',
  good: 'text-foreground',
  warn: 'text-warning',
  bad: 'text-destructive',
};

/** A row of figures in one panel, separated by hairlines. */
export const StatStrip = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <dl
    className={cn(
      'grid grid-cols-2 divide-border overflow-hidden rounded-lg border border-border bg-card sm:grid-flow-col sm:auto-cols-fr sm:grid-cols-none sm:divide-x',
      className,
    )}
  >
    {children}
  </dl>
);

/** One figure. Colour is used only when `tone` says the figure needs attention. */
export const Stat = ({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  /** Small line under the figure: what it covers or compares to. */
  hint?: React.ReactNode;
  tone?: Tone;
}) => (
  <div className="min-w-0 px-5 py-4">
    <dt className="truncate text-[13px] text-muted-foreground">{label}</dt>
    <dd className={cn('mt-1 flex items-baseline gap-1 text-2xl font-semibold leading-8 tracking-tight', toneText[tone])}>
      {value}
      {unit && <span className="text-sm font-medium text-muted-foreground">{unit}</span>}
    </dd>
    {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
  </div>
);

/** A small set of mutually exclusive choices, e.g. a date range. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode }[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex rounded-md bg-muted p-0.5', className)}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={cn(
              'pressable inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 text-[13px] font-medium',
              selected ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Underlined tabs for the sections of one page. */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: { value: T; label: React.ReactNode }[];
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="scrollbar-thin flex gap-5 overflow-x-auto border-b border-border">
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.value)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 pb-2.5 pt-1 text-sm font-medium transition-colors duration-150',
              selected ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

const dotTone: Record<string, string> = {
  running: 'bg-success',
  stoppage: 'bg-destructive',
  stopped_yet_producing: 'bg-warning',
  inactive: 'bg-muted-foreground/50',
};

const statusLabel: Record<string, string> = {
  running: 'Running',
  stoppage: 'Stopped',
  stopped_yet_producing: 'Producing, no power signal',
  inactive: 'Idle',
};

/** Plain-language name of a machine state. */
export const machineStatusLabel = (status: string) => statusLabel[status] ?? 'Idle';

/** Machine state as a coloured dot and a plain-language label. */
export const StatusDot = ({ status, label, className }: { status: string; label?: React.ReactNode | false; className?: string }) => (
  <span className={cn('inline-flex items-center gap-2 whitespace-nowrap text-[13px] text-foreground', className)}>
    <span className={cn('h-2 w-2 shrink-0 rounded-full', dotTone[status] ?? dotTone.inactive)} aria-hidden />
    {label === false ? <span className="sr-only">{machineStatusLabel(status)}</span> : label ?? machineStatusLabel(status)}
  </span>
);

/** Icon-only row action. Always neutral; the label is its tooltip and its accessible name. */
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }
>(({ label, danger, className, children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-label={label}
    title={label}
    className={cn(
      'pressable inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'disabled:pointer-events-none disabled:opacity-40',
      danger ? 'hover:bg-destructive/10 hover:text-destructive' : 'hover:bg-foreground/[0.06] hover:text-foreground',
      className,
    )}
    {...props}
  >
    {children}
  </button>
));
IconButton.displayName = 'IconButton';

/** A label, its control, and an optional hint or error, stacked. */
export const Field = ({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => (
  <label className={cn('block', className)}>
    <span className="mb-1.5 block text-[13px] font-medium text-foreground">{label}</span>
    {children}
    {error ? (
      <span className="mt-1 block text-xs text-destructive">{error}</span>
    ) : (
      hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
    )}
  </label>
);

/** Formats a count with thousands separators. */
export const formatNumber = (n: number | undefined | null) =>
  n == null || Number.isNaN(n) ? '–' : new Intl.NumberFormat().format(Math.round(n));
