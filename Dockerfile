# syntax=docker/dockerfile:1
FROM debian:trixie-slim AS relay-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git g++ make perl pkg-config libtool libssl-dev zlib1g-dev \
    liblmdb-dev libflatbuffers-dev libsecp256k1-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Fetch only during the image build. Keep a full commit SHA here so upstream
# changes cannot silently change the relay on the next rebuild.
ARG STRFRY_COMMIT=4cd3cf64850caf47dda46c2a2abbbf3525a64d10
RUN git init . \
    && git remote add origin https://github.com/hoytech/strfry.git \
    && git fetch --depth 1 origin "$STRFRY_COMMIT" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$STRFRY_COMMIT" \
    && git submodule update --init --depth 1 \
    && make setup-golpe
ARG BUILD_JOBS=2
RUN make -j${BUILD_JOBS} OPT='-O2' && strip strfry
FROM node:24-trixie-slim AS ui-build
WORKDIR /app
COPY lnbits-nrm/package*.json ./
RUN npm ci --no-audit --no-fund
COPY lnbits-nrm/ ./
RUN npm run check && npm test && npm run build

FROM node:24-trixie-slim AS production-deps
WORKDIR /app
COPY lnbits-nrm/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3t64 liblmdb0 lmdb-utils libflatbuffers23.5.26 libsecp256k1-2 libzstd1 ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=relay-build /build/strfry /usr/local/bin/strfry
COPY --from=relay-build /build/LICENSE /app/licenses/strfry.txt
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=ui-build --chown=node:node /app/dist ./dist
COPY --chown=node:node lnbits-nrm/server ./server
COPY --chown=node:node lnbits-nrm/package.json ./package.json
# Package managers are build tools, not part of the running relay or manager.
# Removing them also removes their separate, unused dependency trees.
RUN chmod +x /app/server/plugin.sh \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000
USER node
VOLUME ["/data"]
EXPOSE 3000 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/main.js"]
