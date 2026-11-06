import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { ONNX_ASSETS, ONNX_DIRECTORY } from '../packages/matching/src/onnx-model.mjs';

// Trace verification inspects names and sizes only. It never reads application credentials or private records.
if (process.env.MEETI_SERVERLESS === 'true' && !process.env.BACKEND_API_ORIGIN) {
  const root = process.cwd();
  const manifest = resolve(process.env.NEXT_DIST_DIR || '.next', 'server/app/api/[...path]/route.js.nft.json');
  const traced = JSON.parse(readFileSync(manifest, 'utf8')).files;
  const paths = traced.map(file => resolve(dirname(manifest), file));
  const names = paths.map(file => relative(root, file).replaceAll('\\', '/'));
  if (names.some(name => name.startsWith('../') || /(^|\/)(\.env[^/]*|\.local-data|artifacts|\.git|\.agents|\.codex)(\/|$)/.test(name))) throw new Error('serverless_trace_private_path');
  const modelFiles = new Set([...ONNX_ASSETS.map(asset => `${ONNX_DIRECTORY}/${asset.path}`), `${ONNX_DIRECTORY}/manifest.json`]);
  if (names.some(name => name.startsWith('.models/') && !modelFiles.has(name))) throw new Error('serverless_trace_unreviewed_model');
  for (const file of modelFiles) if (!names.includes(file)) throw new Error('serverless_trace_model_missing');
  for (const file of ['node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1', 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node', 'scripts/extract-private-pdf.mjs']) {
    if (!names.includes(file)) throw new Error('serverless_trace_runtime_missing');
  }
  const bytes = paths.reduce((sum, file) => sum + statSync(file).size, 0);
  if (bytes > 230 * 1024 * 1024) throw new Error('serverless_trace_exceeds_reviewed_size');
  console.log(JSON.stringify({ serverlessBundleVerified: true, files: paths.length, bytes, modelFiles: modelFiles.size, privatePaths: 0, maximumReviewedBytes: 230 * 1024 * 1024 }));
}
