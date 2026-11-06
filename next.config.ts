import type { NextConfig } from "next";
const hostedFrontend = Boolean(process.env.BACKEND_API_ORIGIN);
const serverlessBackend = !hostedFrontend && process.env.MEETI_SERVERLESS === 'true';
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ["node:sqlite", "pdf-parse", "pg", "@huggingface/transformers", "onnxruntime-node"],
  turbopack: { resolveAlias: { 'meeti-api-handler': hostedFrontend ? './packages/server/hosted-proxy.ts' : serverlessBackend ? './packages/server/serverless-route.ts' : './packages/server/router.ts' } },
  outputFileTracingExcludes: { '*': ['./.env*', './.local-data/**/*', './artifacts/**/*', ...(!serverlessBackend ? ['./.models/**/*'] : []), './.git/**/*', './.agents/**/*', './.codex/**/*', './node_modules/**/*.map', './node_modules/onnxruntime-node/bin/napi-v6/darwin/**/*', './node_modules/onnxruntime-node/bin/napi-v6/win32/**/*', './node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**/*'] },
  outputFileTracingIncludes: { '/api/**': ['./scripts/extract-private-pdf.mjs', './node_modules/pdf-parse/**/*', './node_modules/pdfjs-dist/**/*', './node_modules/@napi-rs/canvas*/**/*',
    ...(serverlessBackend ? ['./.models/meeti-minilm-q8/manifest.json', './.models/meeti-minilm-q8/config.json', './.models/meeti-minilm-q8/tokenizer.json', './.models/meeti-minilm-q8/tokenizer_config.json', './.models/meeti-minilm-q8/special_tokens_map.json', './.models/meeti-minilm-q8/onnx/model_quantized.onnx', './node_modules/onnxruntime-node/dist/**/*', './node_modules/onnxruntime-node/bin/napi-v6/linux/x64/*', './node_modules/onnxruntime-common/dist/**/*', './node_modules/@huggingface/transformers/package.json', './licenses/*', './THIRD_PARTY_NOTICES.md'] : [])] },
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }
    ] }];
  }
};
export default config;
