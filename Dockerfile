# Two-stage build: compile with dev dependencies, ship only the compiled output and
# production dependencies. Adapted from the origin platform's Docker skeleton, hardened:
# real lockfile required (no `package-lock.json*` glob masking its absence), a healthcheck,
# and the runtime image carries the migrations so the compose migrate step can run the
# exact code it ships with.
#
# node:20-alpine is pinned by major tag; pin by digest at release time
# (docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine).

FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN npx tsc -p tsconfig.build.json

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

# rootDir "." keeps source structure under dist: dist/src/server.js, dist/scripts/migrate.js.
COPY --from=builder /app/dist ./dist
COPY migrations/ ./migrations/

# Non-root. The service binds a high port and needs no filesystem writes.
RUN addgroup -g 1001 -S cockpit && adduser -S cockpit -u 1001 -G cockpit
USER cockpit

EXPOSE 3000

# node:20-alpine ships busybox wget; /healthz is the liveness probe (src/app.ts).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "dist/src/server.js"]
