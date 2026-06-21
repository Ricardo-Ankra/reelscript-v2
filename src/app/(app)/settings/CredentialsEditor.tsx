'use client';

import { useState } from 'react';
import { CREDENTIAL_PROVIDERS } from '@/lib/credentials/providers';
import {
  saveProviderCredential,
  testProviderCredential,
  deleteProviderCredential,
} from './credential-actions';

export type CredentialRow = { provider: string; status: string; lastValidatedAt: string | null };

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  elevenlabs: 'ElevenLabs',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
};

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'valid':
      return { label: 'Valid', className: 'text-green-600' };
    case 'invalid':
      return { label: 'Invalid', className: 'text-red-600' };
    case 'unverified':
      return { label: 'Unverified', className: 'text-amber-600' };
    default:
      return { label: 'Not set', className: 'opacity-50' };
  }
}

function ProviderRow({ provider, initialStatus }: { provider: string; initialStatus: string }) {
  const [status, setStatus] = useState(initialStatus);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const badge = statusBadge(status);

  async function onSave() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await saveProviderCredential(provider, value);
      if (res.ok) {
        setValue('');
        setStatus('unverified');
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

  async function onTest() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await testProviderCredential(provider);
      if (res.ok) setStatus(res.status);
      else setError(res.reason);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await deleteProviderCredential(provider);
      if (res.ok) setStatus('not_set');
      else setError(res.reason);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <span className="w-28 text-sm font-medium">{PROVIDER_LABELS[provider] ?? provider}</span>
      <span className={`text-xs ${badge.className}`}>{badge.label}</span>
      <input
        type="password"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        placeholder="Enter API key"
        autoComplete="off"
        className="min-w-[12rem] flex-1 rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
      />
      <button
        type="button"
        onClick={onSave}
        disabled={busy || value.trim() === ''}
        className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
      >
        {busy ? '…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={onTest}
        disabled={busy || status === 'not_set'}
        className="rounded border border-black/15 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/15"
      >
        Test
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={busy || status === 'not_set'}
        className="text-sm text-red-600 disabled:opacity-40"
      >
        Remove
      </button>
      {saved && <span className="text-sm text-green-600">Saved</span>}
      {error && <span className="w-full text-sm text-red-600">{error}</span>}
    </div>
  );
}

export function CredentialsEditor({ initial }: { initial: CredentialRow[] }) {
  const byProvider = new Map(initial.map((r) => [r.provider, r]));
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">API credentials</h2>
        <p className="text-sm opacity-70">
          Your own provider keys, encrypted at rest. When set, they override the server defaults;
          when empty, the server keys are used.
        </p>
      </div>
      <div className="space-y-2">
        {CREDENTIAL_PROVIDERS.map((provider) => (
          <ProviderRow key={provider} provider={provider} initialStatus={byProvider.get(provider)?.status ?? 'not_set'} />
        ))}
      </div>
    </div>
  );
}
