# syntax=docker/dockerfile:1
# Free Render API runtime. Vercel serves the frontend through its same-origin API proxy.
FROM node:24-bookworm-slim
WORKDIR /app
# tsx is retained because the API and discovery scheduler execute TypeScript.
COPY package.json package-lock.json ./
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --include=dev --no-audit --no-fund
COPY --chown=node:node packages ./packages
COPY scripts/prepare-embedding-model.mjs ./scripts/prepare-embedding-model.mjs
# Fetch only the model policy's pinned, hash-verified public assets during the image build.
# Inference never downloads a replacement model at runtime.
RUN node scripts/prepare-embedding-model.mjs && node scripts/prepare-embedding-model.mjs --verify && chown -R node:node /app/.models
COPY --chown=node:node scripts/hosted-api.ts ./scripts/hosted-api.ts
COPY --chown=node:node scripts/extract-private-pdf.mjs ./scripts/extract-private-pdf.mjs
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node tsconfig.json ./tsconfig.json
COPY --chown=node:node THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --chown=node:node licenses ./licenses
ENV NODE_ENV=production PORT=10000 DATABASE_PROVIDER=postgres WORLD_CAPABILITY_ENABLED=false
USER node
EXPOSE 10000
CMD ["node", "--import", "tsx", "scripts/hosted-api.ts"]
