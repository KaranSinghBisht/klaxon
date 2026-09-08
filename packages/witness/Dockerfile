# packages/witness/Dockerfile — build context is the repo root.
#
# node:24-bookworm-slim (D6/B §7.1): `node:sqlite` is stable and warning-free there, and the image
# needs no python/make/g++ because nothing native is compiled. `pnpm deploy --prod` flattens the
# workspace into a self-contained tree — pnpm's symlinked store does not survive a COPY.

FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json    packages/core/
COPY packages/witness/package.json packages/witness/
RUN pnpm install --frozen-lockfile --filter @klaxon/witness...

COPY . .
RUN pnpm --filter @klaxon/core build \
 && pnpm --filter @klaxon/witness build \
 && pnpm deploy --filter @klaxon/witness --prod /out

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out /app
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/main.js"]
