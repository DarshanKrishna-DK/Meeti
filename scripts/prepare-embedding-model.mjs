import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ONNX_ASSETS, ONNX_COMMIT, ONNX_DIRECTORY, ONNX_MODEL, ONNX_REVISION, checkOnnxAsset, verifyOnnxAssets } from '../packages/matching/src/onnx-model.mjs';

const options = process.argv.slice(2);
if (options.some(value => value !== '--verify')) throw new Error('Only the optional --verify flag is supported.');
const directory = resolve(ONNX_DIRECTORY), within = relative(process.cwd(), directory);
if (within.startsWith('..') || isAbsolute(within)) throw new Error('The model directory must remain inside the workspace.');
async function safeDirectory(path) {
  try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('onnx_directory_scope_invalid'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; await mkdir(path); }
}

try {
  if (!options.includes('--verify')) {
    await safeDirectory(dirname(directory));
    await safeDirectory(directory);
    for (const asset of ONNX_ASSETS) {
      const target = resolve(directory, asset.path);
      try { await checkOnnxAsset(directory, asset); continue; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await safeDirectory(dirname(target));
      const temporary = `${target}.${randomUUID()}.download`;
      const response = await fetch(`https://huggingface.co/${ONNX_MODEL}/resolve/${ONNX_COMMIT}/${asset.path}`, { signal: AbortSignal.timeout(120000), redirect: 'follow', credentials: 'omit' });
      const final = new URL(response.url);
      if (!response.ok || !response.body || final.protocol !== 'https:' || ![final.hostname.endsWith('.hf.co'), final.hostname === 'huggingface.co', final.hostname.endsWith('.huggingface.co')].some(Boolean)) throw new Error('onnx_download_unavailable_or_untrusted');
      const declared = response.headers.get('content-length');
      if (declared && Number(declared) !== asset.bytes) { await response.body.cancel(); throw new Error('onnx_download_size_mismatch'); }
      let bytes = 0;
      const sha256 = createHash('sha256'), git = createHash('sha1').update(`blob ${asset.bytes}\0`);
      const bounded = async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > asset.bytes) throw new Error('onnx_download_size_exceeded');
          sha256.update(chunk); git.update(chunk); yield chunk;
        }
      };
      let owned = false, handle;
      try {
        handle = await open(temporary, 'wx', 0o600); owned = true;
        await pipeline(Readable.fromWeb(response.body), bounded, handle.createWriteStream());
        if (bytes !== asset.bytes || (asset.sha256 && sha256.digest('hex') !== asset.sha256) || (asset.gitSha1 && git.digest('hex') !== asset.gitSha1)) throw new Error('onnx_download_hash_mismatch');
        await handle.close();
        await rename(temporary, target);
      } catch (error) { await handle?.close().catch(() => {}); if (owned) await unlink(temporary).catch(() => {}); throw error; }
      console.log(JSON.stringify({ file: asset.path, bytes, verified: true }));
    }
    const files = [];
    for (const asset of ONNX_ASSETS) files.push(await checkOnnxAsset(directory, asset));
    const manifest = JSON.stringify({ version: 1, model: ONNX_MODEL, commit: ONNX_COMMIT, modelRevision: ONNX_REVISION, files }, null, 2);
    const target = resolve(directory, 'manifest.json');
    try { const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('onnx_manifest_scope_invalid'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await writeFile(target, manifest, { mode: 0o600 });
  }
  const checked = await verifyOnnxAssets(directory);
  console.log(JSON.stringify({ verified: true, model: checked.model, modelRevision: checked.modelRevision, dimensions: 384, directory: ONNX_DIRECTORY, files: checked.files.length }));
} catch { console.error('onnx_model_preparation_failed_no_endpoint_or_credentials_logged'); process.exitCode = 1; }
