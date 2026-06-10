import { createContext, useContext } from 'react';
import type { Theme } from './contract';

// The composition root wraps every scene in a provider holding the baked theme;
// primitives consume it via useTheme(). This is the only sanctioned way for a
// primitive to obtain brand values. Kept separate from contract.ts because it
// imports react hooks — contract.ts must stay importable from server code (Gate 1)
// without dragging react-client APIs into a react-server bundle.
export const ThemeContext = createContext<Theme | null>(null);

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) {
    throw new Error('useTheme must be used within a ThemeProvider.');
  }
  return theme;
}

// Resolved media assets, keyed by the manifest asset id (Phase 5). Media primitives
// (Image/Video) receive an asset id in their props and look up the signed URL + kind
// here at render time — a primitive is never handed a URL at author time (spec 10.3).
export type ResolvedAsset = { url: string; kind: 'image' | 'video' | 'audio' };
export const AssetContext = createContext<Record<string, ResolvedAsset>>({});

export function useAsset(assetId: string | undefined): ResolvedAsset | undefined {
  const map = useContext(AssetContext);
  return assetId ? map[assetId] : undefined;
}
