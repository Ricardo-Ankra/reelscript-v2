'use client';

import { useState } from 'react';
import { setCostBudget } from './cost-actions';
import { formatUsd } from '@/lib/costs/aggregate';

// Monthly budget cap control (V2 Slice 6b). Sets accounts.monthly_cost_alert_usd
// + monthly_cost_alert_on. When enforcement is on, Auto-produce runs are blocked
// if projected spend exceeds the cap. Mirrors ModelRoutingEditor's dirty-Save.
export function BudgetControl({
  initialCapUsd,
  initialEnabled,
  currentSpendUsd,
}: {
  initialCapUsd: number | null;
  initialEnabled: boolean;
  currentSpendUsd: number;
}) {
  const [cap, setCap] = useState<string>(initialCapUsd != null ? String(initialCapUsd) : '');
  const [enabled, setEnabled] = useState<boolean>(initialEnabled);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function touch() {
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await setCostBudget({ capUsd: cap, enabled });
      if (res.ok) {
        setDirty(false);
        setSaved(true);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <div>
        <h2 className="text-lg font-semibold">Monthly budget</h2>
        <p className="text-sm opacity-70">
          Spent this month: {formatUsd(currentSpendUsd)}
          {cap !== '' ? ` of ${formatUsd(Number(cap) || 0)}` : ''}.
        </p>
      </div>

      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">Monthly cap (USD)</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={cap}
          placeholder="No cap"
          onChange={(e) => {
            setCap(e.target.value);
            touch();
          }}
          className="w-32 rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
        />
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            touch();
          }}
        />
        <span className="text-sm">Block Auto-produce runs that would exceed the cap</span>
      </label>

      {enabled && (
        <p className="text-xs opacity-60">
          Auto-produce runs are blocked when projected spend exceeds this. The manual Generate
          Video button is not affected.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
