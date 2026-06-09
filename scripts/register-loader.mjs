// Registers the TS extension-resolution hook for the test runner. Loaded via
// `node --import ./scripts/register-loader.mjs`.
import { register } from 'node:module';
register('./loader-ts-ext.mjs', import.meta.url);
