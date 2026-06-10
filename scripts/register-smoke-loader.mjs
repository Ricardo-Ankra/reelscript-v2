// Registers the smoke-script resolve hook (server-only stub + TS extension
// resolution). Loaded via `node --import ./scripts/register-smoke-loader.mjs`.
import { register } from 'node:module';
register('./smoke-loader.mjs', import.meta.url);
