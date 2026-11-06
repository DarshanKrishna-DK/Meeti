import type { NextConfig } from "next";
const hostedFrontend = Boolean(process.env.BACKEND_API_ORIGIN);
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ["node:sqlite", "pdf-parse", "pg", "@huggingface/transformers", "onnxruntime-node"],
  turbopack: { resolveAlias: { 'meeti-api-handler': hostedFrontend ? './packages/server/hosted-proxy.ts' : './packages/server/router.ts' } },
  outputFileTracingExcludes: { '*': ['./.env*', './.local-data/**/*', './artifacts/**/*', './.models/**/*', './.git/**/*', './.agents/**/*', './.codex/**/*'] },
  outputFileTracingIncludes: { '/api/**': ['./scripts/extract-private-pdf.mjs', './node_modules/pdf-parse/**/*', './node_modules/pdfjs-dist/**/*', './node_modules/@napi-rs/canvas*/**/*'] },
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
