import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import apiService from '../services/api';
import { Button, IconButton, Input, Section, Select } from './ui';
import {
  KIND_HINTS, KIND_LABELS, keyFromLabel, useStoppageReasons, type ReasonKind, type StoppageReason,
} from '../lib/reasons';

/* The list operators pick from when a machine stops. Order here is the order
   of the tiles they see, so the most common reasons belong at the top. A
   reason's key is fixed once saved, because past stoppages refer to it; its
   label and kind can change at any time. */

interface Row extends StoppageReason {
  /** Not saved yet, so its key still follows its label. */
  fresh?: boolean;
}

const KINDS: ReasonKind[] = ['unplanned', 'breakdown', 'planned'];
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const StoppageReasonsSettings: React.FC = () => {
  const queryClient = useQueryClient();
  const { reasons, isLoading } = useStoppageReasons();
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);

  // Follow the saved list until the person starts editing.
  useEffect(() => {
    if (!dirty && !isLoading) setRows(reasons);
  }, [reasons, isLoading, dirty]);

  const change = (next: Row[]) => {
    setRows(next);
    setDirty(true);
  };
  const edit = (index: number, patch: Partial<Row>) => change(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const move = (index: number, by: number) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    change(next);
  };

  const blank = rows.some((r) => !r.label.trim());
  const labels = rows.map((r) => r.label.trim().toLowerCase());
  const duplicate = labels.some((l, i) => l && labels.indexOf(l) !== i);
  const problem = rows.length === 0
    ? 'Keep at least one reason.'
    : blank
      ? 'Every reason needs a name.'
      : duplicate
        ? 'Two reasons have the same name.'
        : null;

  const save = useMutation({
    mutationFn: () => {
      const taken = new Set(rows.filter((r) => !r.fresh).map((r) => r.key));
      const stoppageReasons = rows.map((r) => {
        if (!r.fresh) return { key: r.key, label: r.label.trim(), kind: r.kind };
        const key = keyFromLabel(r.label, taken);
        taken.add(key);
        return { key, label: r.label.trim(), kind: r.kind };
      });
      return apiService.updateConfig({ stoppageReasons });
    },
    onSuccess: () => {
      toast.success('Stoppage reasons saved');
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['stoppage-reasons'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (e) => toast.error(errMsg(e, 'Could not save the reasons')),
  });

  return (
    <Section
      flush
      title="Stoppage reasons"
      description="What operators choose from when a machine stops. The order here is the order they see."
      actions={
        <Button variant="outline" size="sm" onClick={() => change([...rows, { key: '', label: '', kind: 'unplanned', fresh: true }])}>
          <Plus className="h-4 w-4" /> Add reason
        </Button>
      }
    >
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-5 py-2 font-medium">Name</th>
              <th scope="col" className="px-5 py-2 font-medium">Counts as</th>
              <th scope="col" className="px-5 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row, i) => (
              <tr key={row.fresh ? `new-${i}` : row.key}>
                <td className="px-5 py-2.5 align-top">
                  <Input
                    aria-label="Reason name"
                    value={row.label}
                    placeholder="e.g. Waiting for quality check"
                    autoFocus={row.fresh && !row.label}
                    onChange={(e) => edit(i, { label: e.target.value })}
                  />
                </td>
                <td className="px-5 py-2.5 align-top">
                  <Select aria-label="Counts as" className="w-48" value={row.kind} onChange={(e) => edit(i, { kind: e.target.value as ReasonKind })}>
                    {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </Select>
                  <p className="mt-1 max-w-xs text-xs text-muted-foreground">{KIND_HINTS[row.kind]}</p>
                </td>
                <td className="px-5 py-2.5 align-top">
                  <div className="flex justify-end gap-1">
                    <IconButton label={`Move ${row.label || 'this reason'} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={`Move ${row.label || 'this reason'} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={`Remove ${row.label || 'this reason'}`} danger onClick={() => change(rows.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          {problem ? <span className="text-destructive">{problem}</span> : 'Removing a reason keeps past stoppages; they show under its old name.'}
        </p>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !!problem}>Save changes</Button>
      </div>
    </Section>
  );
};

export default StoppageReasonsSettings;
