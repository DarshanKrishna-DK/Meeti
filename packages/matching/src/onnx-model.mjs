import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const ONNX_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const ONNX_COMMIT = '751bff37182d3f1213fa05d7196b954e230abad9';
export const ONNX_LIBRARY_VERSION = '4.3.2';
export const ONNX_REVISION = `${ONNX_COMMIT}:q8:mean-l2:max256:tjs${ONNX_LIBRARY_VERSION}`;
export const ONNX_DIMENSIONS = 384;
export const ONNX_MAX_TOKENS = 256;
export const ONNX_DIRECTORY = '.models/meeti-minilm-q8';

// Pinned public Hugging Face tree metadata, checked on 7 November 2026. No runtime network lookup is needed.
// https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9?recursive=true
// Weight SHA-256: https://huggingface.co/Xenova/all-MiniLM-L6-v2/blob/751bff37182d3f1213fa05d7196b954e230abad9/onnx/model_quantized.onnx
export const ONNX_ASSETS = Object.freeze([
  { path: 'config.json', bytes: 650, gitSha1: '72147e4ff4426ebedbfa2146c4a0999def51a313', sha256: null },
  { path: 'tokenizer.json', bytes: 711661, gitSha1: 'c17ed520ed8438736732a54957a69306b8822215', sha256: null },
  { path: 'tokenizer_config.json', bytes: 366, gitSha1: '37fca74771bc76a8e01178ce3a6055a0995f8093', sha256: null },
  { path: 'special_tokens_map.json', bytes: 125, gitSha1: 'a8b3208c2884c4efb86e49300fdd3dc877220cdf', sha256: null },
  { path: 'onnx/model_quantized.onnx', bytes: 22972370, gitSha1: null, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
]);

export async function checkOnnxAsset(directory, asset) {
  const base = await realpath(directory), target = resolve(base, asset.path);
  const stat = await lstat(target);
  const actual = await realpath(target), within = relative(base, actual);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes || within.startsWith('..') || isAbsolute(within)) throw new Error('onnx_asset_scope_or_size_invalid');
  const sha256 = createHash('sha256'), git = createHash('sha1').update(`blob ${stat.size}\0`);
  for await (const chunk of createReadStream(target)) { sha256.update(chunk); git.update(chunk); }
  const digest = sha256.digest('hex');
  if ((asset.sha256 && digest !== asset.sha256) || (asset.gitSha1 && git.digest('hex') !== asset.gitSha1)) throw new Error('onnx_asset_hash_mismatch');
  return { path: asset.path, bytes: stat.size, sha256: digest };
}

export async function verifyOnnxAssets(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('onnx_asset_directory_invalid');
  const file = resolve(directory, 'manifest.json'), manifestStat = await lstat(file);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 8192) throw new Error('onnx_manifest_invalid');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.version !== 1 || manifest.model !== ONNX_MODEL || manifest.commit !== ONNX_COMMIT || manifest.modelRevision !== ONNX_REVISION
    || !Array.isArray(manifest.files) || manifest.files.length !== ONNX_ASSETS.length) throw new Error('onnx_manifest_binding_invalid');
  const files = [];
  for (const asset of ONNX_ASSETS) {
    const checked = await checkOnnxAsset(directory, asset), stored = manifest.files.find(value => value.path === asset.path);
    if (!stored || stored.bytes !== checked.bytes || stored.sha256 !== checked.sha256) throw new Error('onnx_manifest_hash_mismatch');
    files.push(checked);
  }
  return { model: ONNX_MODEL, modelRevision: ONNX_REVISION, files };
}
