import { HttpError } from './security';

// Disabled unless explicitly enabled by the operator after the owner resumes this integration.
export function worldEnabled(): boolean { return process.env.WORLD_CAPABILITY_ENABLED === 'true'; }
export function requireWorldCapability(): void {
  if (!worldEnabled()) throw new HttpError(503, 'WORLD_PAUSED', 'World verification is paused. Protected introductions remain locked.');
}
