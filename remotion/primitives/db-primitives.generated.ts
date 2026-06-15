import type { ComponentType } from 'react';

// Account-authored primitives, injected into the render bundle (Phase 7, spec 9.7).
// This file is committed EMPTY; the primitive/deploy job overwrites it transiently at
// bundle time to import the active DB primitives (from ./db/, gitignored), then restores
// it to empty so the working tree stays clean. The deployed R2 bundle is what Lambda
// renders from, so it carries the authored primitives even though this file is empty here.
export const DB_PRIMITIVES: Record<string, ComponentType<Record<string, unknown>>> = {};
