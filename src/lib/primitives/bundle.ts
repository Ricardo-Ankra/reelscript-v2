import 'server-only';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deploySite, deleteSite, getOrCreateBucket, renderStillOnLambda, type AwsRegion } from '@remotion/lambda';
import { serverEnv } from '../env.server';
import type { Theme } from './contract';
import { frameLooksBlank } from '../ai/vision';

// Dynamic primitive bundling (Phase 7, spec 9.6/9.7) — the studio's central capability:
// take primitive CODE AS A STRING, bundle a Remotion site that includes it, and render
// it on Lambda. Powers the smoke gate (isolated harness) and the live re-bundle.
//
// We write the candidate into a workspace INSIDE the repo (.primitive-cache/, gitignored)
// so `remotion`/`react` resolve via repo/node_modules and relative imports reach src/lib.
// OPEN ITEM (spec 9.6, production): Vercel's FS is read-only outside /tmp — production
// bundling needs a writable workspace (a build Lambda or a /tmp self-contained bundle);
// this dev path proves the mechanic.

const CACHE_ROOT = path.join(process.cwd(), '.primitive-cache');

// The candidate imports `./theme` (the whitelist alias) for useTheme/useAsset + the
// contract types; we satisfy it from the real modules. Relative depth: .primitive-cache/<id>/.
const THEME_SHIM = `export { useTheme, useAsset } from '../../src/lib/primitives/theme-context';
export type { ResolvedAsset } from '../../src/lib/primitives/theme-context';
export type { Theme, PropSchema, PropDef, PrimitiveMeta } from '../../src/lib/primitives/contract';
`;

// A real, self-contained sample image (SVG data URL) the gate's AssetContext serves for
// any `asset` prop, so media primitives resolve to a visible image during the smoke/brand
// gates instead of a broken src.
const SAMPLE_IMAGE_URL =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20600%20600'%3E%3Crect%20width='600'%20height='600'%20fill='%233B82F6'/%3E%3Ccircle%20cx='300'%20cy='300'%20r='170'%20fill='%23F59E0B'/%3E%3C/svg%3E";

export interface GateSite {
  serveUrl: string;
  cleanup: () => Promise<void>;
}

// Bundle an ISOLATED harness site: just the candidate + a 'Gate' composition that renders
// it once with sample props under the brand-kit ThemeContext. Untrusted code executes only
// in the Lambda render sandbox (no secrets/DB/R2-write), per spec 9.6.
export async function bundleGateSite(
  code: string,
  sampleProps: Record<string, unknown>,
  theme: Theme,
): Promise<GateSite> {
  const id = createHash('sha256').update(code).update(JSON.stringify(sampleProps)).digest('hex').slice(0, 16);
  const dir = path.join(CACHE_ROOT, `gate-${id}`);
  await mkdir(dir, { recursive: true });

  await writeFile(path.join(dir, 'theme.ts'), THEME_SHIM);
  await writeFile(path.join(dir, 'Candidate.tsx'), code);
  await writeFile(path.join(dir, 'index.tsx'), harnessEntry(sampleProps, theme));

  const region = serverEnv.aws.region as AwsRegion;
  const { bucketName } = await getOrCreateBucket({ region });
  const siteName = `gate-${id}`;
  const { serveUrl } = await deploySite({ entryPoint: path.join(dir, 'index.tsx'), bucketName, region, siteName });

  // Cleanup removes BOTH the local workspace and the throwaway S3 gate site, so gate
  // runs don't leave orphaned sites behind.
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await deleteSite({ bucketName, siteName, region }).catch(() => {});
  };
  return { serveUrl, cleanup };
}

// Render the harness mid-frame on Lambda; mechanical not-blank check (reuses the Gate-2
// byte-floor heuristic). With no override it renders the baked default props/theme
// (smoke); an override drives the brand stress kit (same bundle, just different
// inputProps), so the brand gate costs N renders, not N bundles.
export async function renderGateStill(
  serveUrl: string,
  override?: { props?: Record<string, unknown>; theme?: Theme },
): Promise<{ blank: boolean; frameUrl: string; costUsd: number }> {
  const region = serverEnv.aws.region as AwsRegion;
  const still = await renderStillOnLambda({
    region,
    functionName: serverEnv.remotion.functionName,
    serveUrl,
    composition: 'Gate',
    inputProps: override ?? {},
    imageFormat: 'png',
    privacy: 'private',
    frame: 15,
  });
  return {
    blank: frameLooksBlank(still.sizeInBytes),
    frameUrl: still.url,
    costUsd: still.estimatedPrice?.accruedSoFar ?? 0,
  };
}

// --- live site re-bundle (spec 9.7) ----------------------------------------
//
// Regenerate the render bundle so it carries the account's authored primitives, then
// deploy it over the live `reelscript` site. We write each primitive into
// remotion/primitives/db/ (gitignored) + a theme shim, overwrite the committed
// db-primitives.generated.ts to import them, bundle the REAL entry, then RESTORE the
// generated file to empty so the working tree stays clean (the deployed R2 bundle keeps
// the primitives). OPEN ITEM (spec 9.7): production needs a writable workspace; this dev
// path proves the mechanic. In-flight render pinning is deferred (overwrite single site).
const PRIMITIVES_DIR = path.join(process.cwd(), 'remotion', 'primitives');
const DB_DIR = path.join(PRIMITIVES_DIR, 'db');
const GENERATED = path.join(PRIMITIVES_DIR, 'db-primitives.generated.ts');
const GENERATED_EMPTY = `import type { ComponentType } from 'react';

// Account-authored primitives, injected into the render bundle (Phase 7, spec 9.7).
// This file is committed EMPTY; the primitive/deploy job overwrites it transiently at
// bundle time to import the active DB primitives (from ./db/, gitignored), then restores
// it to empty so the working tree stays clean. The deployed R2 bundle is what Lambda
// renders from, so it carries the authored primitives even though this file is empty here.
export const DB_PRIMITIVES: Record<string, ComponentType<Record<string, unknown>>> = {};
`;
const DB_THEME_SHIM = `export { useTheme, useAsset } from '../../../src/lib/primitives/theme-context';
export type { ResolvedAsset } from '../../../src/lib/primitives/theme-context';
export type { Theme, PropSchema, PropDef, PrimitiveMeta } from '../../../src/lib/primitives/contract';
`;

export async function deployLiveSite(primitives: { name: string; code: string }[]): Promise<{ serveUrl: string }> {
  await mkdir(DB_DIR, { recursive: true });
  await writeFile(path.join(DB_DIR, 'theme.ts'), DB_THEME_SHIM);
  for (const p of primitives) await writeFile(path.join(DB_DIR, `${p.name}.tsx`), p.code);

  const imports = primitives.map((p, i) => `import P${i} from './db/${p.name}';`).join('\n');
  const entries = primitives.map((p, i) => `  ${JSON.stringify(p.name)}: P${i} as unknown as ComponentType<Record<string, unknown>>,`).join('\n');
  const generated = `import type { ComponentType } from 'react';\n${imports}\nexport const DB_PRIMITIVES: Record<string, ComponentType<Record<string, unknown>>> = {\n${entries}\n};\n`;

  try {
    await writeFile(GENERATED, generated);
    const region = serverEnv.aws.region as AwsRegion;
    const { bucketName } = await getOrCreateBucket({ region });
    const { serveUrl } = await deploySite({
      entryPoint: path.join(process.cwd(), 'remotion', 'index.ts'),
      bucketName,
      region,
      siteName: 'reelscript',
    });
    return { serveUrl };
  } finally {
    // Always restore the committed empty version so git stays clean.
    await writeFile(GENERATED, GENERATED_EMPTY).catch(() => {});
  }
}

// The harness entry. The default props/theme are baked in (so smoke renders without an
// override), but the 'Gate' composition reads props+theme from inputProps, so the brand
// gate can re-render the SAME bundle with stress-kit variants. JSON.stringify is safe —
// props/theme are plain data.
function harnessEntry(sampleProps: Record<string, unknown>, theme: Theme): string {
  return `import { registerRoot, Composition, AbsoluteFill } from 'remotion';
import { ThemeContext, AssetContext } from '../../src/lib/primitives/theme-context';
import Candidate from './Candidate';

const DEFAULT_PROPS = ${JSON.stringify(sampleProps)};
const DEFAULT_THEME = ${JSON.stringify(theme)};
// Any 'asset' prop ('sample-asset') resolves to a visible image via useAsset.
const SAMPLE_ASSETS = ${JSON.stringify({ 'sample-asset': { url: SAMPLE_IMAGE_URL, kind: 'image' } })};

const Harness = ({ props, theme }) => {
  const t = theme || DEFAULT_THEME;
  return (
    <ThemeContext.Provider value={t}>
      <AssetContext.Provider value={SAMPLE_ASSETS}>
        <AbsoluteFill style={{ backgroundColor: t.colors.background }}>
          <Candidate {...(props || DEFAULT_PROPS)} />
        </AbsoluteFill>
      </AssetContext.Provider>
    </ThemeContext.Provider>
  );
};

registerRoot(() => (
  <Composition
    id="Gate"
    component={Harness}
    durationInFrames={30}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ props: DEFAULT_PROPS, theme: DEFAULT_THEME }}
  />
));
`;
}
