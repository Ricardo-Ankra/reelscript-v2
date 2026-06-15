'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { draftPrimitive, runPrimitiveGates, savePrimitive, getDeployState, type GatesResult } from './actions';
import type { PropSchema } from '@/lib/primitives/contract';
import type { GateResult } from '@/lib/primitives/gates';

// Bounded auto-fix budget (spec 9.6.1): unattended retries, reset by a new instruction.
const MAX_AUTOFIX = 3;

function gateFeedback(gates: GateResult[]): string {
  return gates.filter((g) => !g.passed).map((g) => `[${g.gate}] ${g.reason ?? 'failed'}`).join('\n');
}

// The three-pane authoring studio (Phase 7, spec 9.4): Draft-with-AI · code+schema editor ·
// preview + live gates. Save stays disabled until all gates pass. Lightweight (textarea)
// editor; the "preview" is the smoke-gate frame (no in-browser compiler).
export interface StudioPrimitive {
  id?: string;
  name: string;
  description: string;
  code: string;
  propSchema: PropSchema;
}

const PANE = 'rounded-lg border border-black/10 bg-black/[0.015] p-3 dark:border-white/10 dark:bg-white/[0.02]';
const BTN =
  'rounded-md border border-black/15 px-2.5 py-1 text-sm font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]';

export function Studio({ initial }: { initial: StudioPrimitive }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [code, setCode] = useState(initial.code);
  const [schemaText, setSchemaText] = useState(JSON.stringify(initial.propSchema, null, 2));
  const [instruction, setInstruction] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | 'draft' | 'gates' | 'autofix' | 'save'>(null);
  const [gates, setGates] = useState<GatesResult | null>(null);
  const [deploy, setDeploy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parseSchema = useCallback((): PropSchema => JSON.parse(schemaText) as PropSchema, [schemaText]);

  const onDraft = useCallback(async () => {
    if (!instruction.trim()) return;
    setError(null);
    setBusy('draft');
    setLog((l) => [...l, `You: ${instruction}`]);
    const res = await draftPrimitive({
      instruction,
      currentCode: code.trim() || undefined,
      currentSchema: code.trim() ? safe(parseSchema) : undefined,
    });
    if ('error' in res) {
      setError(res.error);
    } else {
      setCode(res.code);
      setSchemaText(JSON.stringify(res.proposedSchema, null, 2));
      setName(res.meta.name);
      setDescription(res.meta.description);
      setGates(null);
      setLog((l) => [...l, `AI: drafted ${res.meta.name} (${res.proposedSchema.length} props)`]);
    }
    setInstruction('');
    setBusy(null);
  }, [instruction, code, parseSchema]);

  // Run the gates; on failure, the bounded auto-fix loop (spec 9.6.1) feeds the failure
  // reasons + the failing frame back to the AI and re-runs, up to MAX_AUTOFIX times.
  const onRunGates = useCallback(async () => {
    setError(null);
    let curSchema: PropSchema;
    try {
      curSchema = parseSchema();
    } catch {
      setError('Prop schema is not valid JSON.');
      return;
    }
    let curCode = code;
    setBusy('gates');
    setGates(null);
    let result: GatesResult;
    try {
      result = await runPrimitiveGates({ code: curCode, propSchema: curSchema });
    } catch (e) {
      setError(`Gates failed to run: ${(e as Error).message}`);
      setBusy(null);
      return;
    }
    setGates(result);

    let attempt = 0;
    while (!result.passed && attempt < MAX_AUTOFIX) {
      attempt++;
      setLog((l) => [...l, `Auto-fix ${attempt}/${MAX_AUTOFIX}…`]);
      setBusy('autofix');
      const d = await draftPrimitive({
        instruction: "Fix the failing gates while preserving the primitive's intent.",
        currentCode: curCode,
        currentSchema: curSchema,
        feedback: gateFeedback(result.gates),
        failingFrameDataUrl: result.frameDataUrl,
      });
      if ('error' in d) {
        setError(d.error);
        break;
      }
      curCode = d.code;
      curSchema = d.proposedSchema;
      setCode(curCode);
      setSchemaText(JSON.stringify(curSchema, null, 2));
      setName(d.meta.name);
      setDescription(d.meta.description);
      setBusy('gates');
      try {
        result = await runPrimitiveGates({ code: curCode, propSchema: curSchema });
      } catch (e) {
        setError(`Gates failed to run: ${(e as Error).message}`);
        break;
      }
      setGates(result);
    }
    if (result.passed && attempt > 0) setLog((l) => [...l, `Auto-fix succeeded after ${attempt} attempt(s).`]);
    else if (!result.passed && attempt >= MAX_AUTOFIX) setLog((l) => [...l, 'Auto-fix exhausted — over to you (a new instruction resets it).']);
    setBusy(null);
  }, [code, parseSchema]);

  const onSave = useCallback(async () => {
    setError(null);
    let propSchema: PropSchema;
    try {
      propSchema = parseSchema();
    } catch {
      setError('Prop schema is not valid JSON.');
      return;
    }
    setBusy('save');
    setDeploy('saving…');
    const res = await savePrimitive({ primitiveId: initial.id, code, propSchema, meta: { name, description, version: 1 } });
    if ('error' in res) {
      setError(res.error);
      setDeploy(null);
      setBusy(null);
      return;
    }
    setDeploy('re-bundling the render site…');
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await getDeployState(res.deployJobId);
      if (s.status === 'complete') {
        setDeploy('deployed — the composition AI can now use it.');
        break;
      }
      if (s.status === 'failed') {
        setDeploy('deploy failed — primitive saved but not in the bundle.');
        break;
      }
    }
    setBusy(null);
    router.refresh();
  }, [initial.id, code, name, description, parseSchema, router]);

  const passed = gates?.passed === true;

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {/* Draft with AI */}
      <section className={PANE}>
        <h2 className="mb-2 text-sm font-semibold">Draft with AI</h2>
        <div className="mb-2 max-h-40 space-y-1 overflow-y-auto text-xs opacity-70">
          {log.length === 0 ? <p>Describe the primitive you want, then refine.</p> : log.map((l, i) => <p key={i}>{l}</p>)}
        </div>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. a labelled progress bar that fills to a percent"
          rows={3}
          className="w-full rounded-md border border-black/10 bg-transparent p-2 text-sm dark:border-white/10"
        />
        <button type="button" disabled={busy !== null} onClick={onDraft} className={`${BTN} mt-2`}>
          {busy === 'draft' ? 'Drafting…' : code.trim() ? 'Refine' : 'Draft'}
        </button>
      </section>

      {/* Code + schema editor */}
      <section className={PANE}>
        <h2 className="mb-2 text-sm font-semibold">Code & schema</h2>
        <div className="mb-2 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-1/2 rounded-md border border-black/10 bg-transparent px-2 py-1 text-sm dark:border-white/10" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="w-1/2 rounded-md border border-black/10 bg-transparent px-2 py-1 text-sm dark:border-white/10" />
        </div>
        <textarea
          value={code}
          onChange={(e) => { setCode(e.target.value); setGates(null); }}
          spellCheck={false}
          rows={18}
          className="w-full rounded-md border border-black/10 bg-transparent p-2 font-mono text-xs dark:border-white/10"
          placeholder="// the drafted TSX appears here; edit freely"
        />
        <details className="mt-2">
          <summary className="cursor-pointer text-xs opacity-70">Prop schema (JSON)</summary>
          <textarea
            value={schemaText}
            onChange={(e) => { setSchemaText(e.target.value); setGates(null); }}
            spellCheck={false}
            rows={8}
            className="mt-1 w-full rounded-md border border-black/10 bg-transparent p-2 font-mono text-xs dark:border-white/10"
          />
        </details>
      </section>

      {/* Preview + gates */}
      <section className={PANE}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Preview & gates</h2>
          <button type="button" disabled={busy !== null || !code.trim()} onClick={onRunGates} className={BTN}>
            {busy === 'gates' ? 'Running…' : busy === 'autofix' ? 'Auto-fixing…' : 'Run gates'}
          </button>
        </div>
        {gates?.frameDataUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={gates.frameDataUrl} alt="gate frame" className="mb-2 w-full rounded-md border border-black/10 dark:border-white/10" />
        )}
        <ul className="space-y-1 text-xs">
          {(gates?.gates ?? [{ gate: 'lint' }, { gate: 'compile' }, { gate: 'smoke' }, { gate: 'brand' }]).map((g) => (
            <li key={g.gate} className="flex items-start gap-2">
              <span>{'passed' in g ? (g.passed ? '✓' : '✗') : '·'}</span>
              <span className={'passed' in g && !g.passed ? 'text-red-600' : ''}>
                <strong>{g.gate}</strong>
                {'reason' in g && g.reason ? ` — ${g.reason}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <button type="button" disabled={busy !== null || !passed} onClick={onSave} className={`${BTN} mt-3 w-full`}>
          {busy === 'save' ? 'Saving…' : 'Save to library'}
        </button>
        {!passed && <p className="mt-1 text-xs opacity-60">Save unlocks when all gates pass.</p>}
        {deploy && <p className="mt-2 text-xs opacity-80">{deploy}</p>}
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </section>
    </div>
  );
}

function safe(fn: () => PropSchema): PropSchema | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
