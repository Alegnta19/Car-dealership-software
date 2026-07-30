# Two-stage workspace build: compile with dev dependencies, ship only compiled output
# and production dependencies. The runner keeps the npm-workspaces layout (all package
# manifests + node_modules symlinks) so `require('@dealer/*')` resolves exactly as in
# development — no bundling, no path rewriting.
#
# The base image is pinned by digest (multi-arch manifest-list digest for node:20-alpine,
# resolved 2026-07-30); Dependabot's docker ecosystem is the approved mechanism that
# proposes digest updates (.github/dependabot.yml).

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY packages/database/package.json packages/database/
COPY packages/fixed-ops/package.json packages/fixed-ops/
COPY packages/test-kit/package.json packages/test-kit/
COPY packages/ui/package.json packages/ui/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
# The image needs the API and the compiled migrate runner; worker/web build in CI, not here.
RUN npx tsc -b apps/api scripts

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner

WORKDIR /app
ENV NODE_ENV=production

# npm ci validates the lockfile against the whole workspace tree, so every workspace
# manifest is present even where its dist is not shipped (test-kit, worker, web, ui).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY packages/database/package.json packages/database/
COPY packages/fixed-ops/package.json packages/fixed-ops/
COPY packages/test-kit/package.json packages/test-kit/
COPY packages/ui/package.json packages/ui/
RUN npm ci --ignore-scripts --omit=dev

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/platform/dist packages/platform/dist
COPY --from=builder /app/packages/database/dist packages/database/dist
COPY --from=builder /app/packages/fixed-ops/dist packages/fixed-ops/dist
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/scripts/dist scripts/dist
# scripts/dist/migrate.js resolves ../../migrations => /app/migrations (dual-layout logic).
COPY migrations/ ./migrations/

# Non-root. The service binds a high port and needs no filesystem writes.
RUN addgroup -g 1001 -S cockpit && adduser -S cockpit -u 1001 -G cockpit
USER cockpit

EXPOSE 3000

# node:20-alpine ships busybox wget; /healthz is the liveness probe (apps/api/src/app.ts).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "apps/api/dist/server.js"]
