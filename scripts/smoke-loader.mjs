// ESM resolve hook for standalone smoke scripts run under plain `node`.
// `server-only`/`client-only` are bundler guards (Next provides them) and are not
// real npm modules here, so stub them to empty; everything else reuses the test
// runner's extensionless-TS resolution so source imports resolve unchanged.
import { resolve as tsResolve } from './loader-ts-ext.mjs';

const EMPTY = 'data:text/javascript,export%20%7B%7D';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only' || specifier === 'client-only') {
    return { url: EMPTY, shortCircuit: true };
  }
  return tsResolve(specifier, context, nextResolve);
}
