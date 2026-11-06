import { PDFParse } from 'pdf-parse';

// This isolated process receives bytes only, without filenames, URLs, or application credentials.
globalThis.fetch = async () => { throw new Error('Network access is disabled for private document extraction.'); };
if (typeof process.send !== 'function') {
  process.exitCode = 1;
} else {
  process.once('message', async bytes => {
    let parser;
    let response = { extractionStatus: 'failed', extractedText: '' };
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1048576) throw new Error('Invalid document input.');
      parser = new PDFParse({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, stopAtErrors: true,
        useWorkerFetch: false, useWasm: false, enableXfa: false, disableAutoFetch: true, disableStream: true,
        isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 0 });
      const result = await parser.getText({ first: 5, parseHyperlinks: false, pageJoiner: '' });
      const extractedText = result.pages.map(page => page.text).join('\n\n').replace(/\0/g, '').slice(0, 12000).trim();
      await parser.destroy();
      parser = undefined;
      response = { extractionStatus: extractedText ? 'ready' : 'no-text', extractedText };
    } catch {
      try { await parser?.destroy(); } catch { /* The parent enforces the process deadline. */ }
    }
    process.send(response, () => { process.disconnect(); process.exit(0); });
  });
}
