import { resolve } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { MAX_DOCUMENT_BYTES, MAX_EXTRACTED_TEXT } from './context-store';

export type PdfExtraction = { extractionStatus: 'ready' | 'no-text' | 'failed'; extractedText: string };
const cache = globalThis as typeof globalThis & { meetiPdfProcesses?: number };
export const PDF_EXTRACTION_TIMEOUT_MS = 8000;
export function extractPrivatePdf(bytes: Uint8Array): Promise<PdfExtraction> {
  if (!bytes.byteLength || bytes.byteLength > MAX_DOCUMENT_BYTES || (cache.meetiPdfProcesses || 0) >= 2) {
    return Promise.resolve({ extractionStatus: 'failed', extractedText: '' });
  }
  cache.meetiPdfProcesses = (cache.meetiPdfProcesses || 0) + 1;
  return new Promise(resolveResult => {
    let child: ChildProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false, released = false;
    let pendingResult: PdfExtraction | undefined;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      cache.meetiPdfProcesses = Math.max(0, (cache.meetiPdfProcesses || 1) - 1);
    };
    const finish = (result: PdfExtraction, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate && child) child.kill('SIGKILL');
      if (!child) release();
      resolveResult(result);
    };
    const failed = () => finish({ extractionStatus: 'failed', extractedText: '' }, true);
    try {
      child = fork(resolve(/* turbopackIgnore: true */ 'scripts/extract-private-pdf.mjs'), [], {
        serialization: 'advanced', execArgv: ['--max-old-space-size=128'], env: {} as NodeJS.ProcessEnv, windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      timer = setTimeout(failed, PDF_EXTRACTION_TIMEOUT_MS);
      child.once('error', () => { release(); failed(); });
      child.once('exit', code => { release(); if (!settled) { if (code === 0 && pendingResult) finish(pendingResult); else failed(); } });
      child.once('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('extractedText' in message) || typeof message.extractedText !== 'string'
          || !('extractionStatus' in message) || !['ready', 'no-text', 'failed'].includes(String(message.extractionStatus))) return failed();
        if (message.extractionStatus === 'failed') { pendingResult = { extractionStatus: 'failed', extractedText: '' }; return; }
        const extractedText = message.extractedText.replace(/\0/g, '').slice(0, MAX_EXTRACTED_TEXT).trim();
        pendingResult = { extractionStatus: extractedText ? 'ready' : 'no-text', extractedText };
      });
      child.send(Uint8Array.from(bytes), error => { if (error) failed(); });
    } catch { failed(); }
  });
}
