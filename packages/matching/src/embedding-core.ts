import { createHash } from 'node:crypto';

export class MatchingError extends Error {
  constructor(public readonly code: 'configuration' | 'input' | 'provider' | 'output' | 'timeout' | 'budget', message: string) {
    super(message); this.name = 'MatchingError';
  }
}
export type EmbeddingReceipt = { model: string; modelRevision: string; dimensions: number; format: string; requests: number; metadataRequests?: number; cacheHits: number; inputTokens: number; estimatedCostUsd: number };
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<{ vectors: number[][]; receipt: EmbeddingReceipt }>;
}
export function contentHash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function validateVector(vector: unknown, dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) throw new MatchingError('output', 'The embedding vector has invalid dimensions or numeric values.');
  const scale = Math.max(...vector.map(Math.abs));
  if (!Number.isFinite(scale) || scale === 0) throw new MatchingError('output', 'An embedding vector must have a finite nonzero norm.');
  return vector;
}
