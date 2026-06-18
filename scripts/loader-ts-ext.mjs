// ESM resolve hook for `node --test`: lets extensionless relative imports in source
// (the repo's convention, e.g. `import ... from '../primitives/contract'`) resolve
// to their .ts/.tsx file when running tests under --experimental-strip-types, which
// otherwise does no extension resolution. Source stays extensionless (the bundler +
// tsc resolve it via moduleResolution:'bundler'); only the test runner needs this.
//
// Also intercepts 'server-only' to allow test imports (tests are not runtime client code).
export async function resolve(specifier, context, nextResolve) {
  // Allow server-only to be imported in tests by returning a dummy module
  if (specifier === 'server-only') {
    return {
      url: 'node:fs', // use a known module that exists and is safe
      format: 'builtin',
      shortCircuit: true,
    };
  }

  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  const hasKnownExt = /\.(m|c)?(j|t)sx?$|\.json$/.test(specifier);
  if (relative && !hasKnownExt) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        // try the next extension, then fall through to default resolution
      }
    }
  }
  return nextResolve(specifier, context);
}
