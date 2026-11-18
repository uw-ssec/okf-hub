# Engine: the okf Wasm engine and tool schemas, built from the pinned fork commit
# (the same steps as scripts/build-engine.sh). GOOS=js GOARCH=wasm does not depend on the build platform.
FROM golang:1.26 AS engine
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY engine/FORK_COMMIT /FORK_COMMIT
RUN git clone -q https://github.com/uw-ssec/okf-agent-memory.git /fork \
 && git -C /fork -c advice.detachedHead=false checkout -q "$(tr -d '[:space:]' < /FORK_COMMIT)"
WORKDIR /fork
RUN mkdir -p /out \
 && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /out/okf-engine.wasm ./cmd/okf-wasm-engine \
 && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js \
 && cp pkg/okf/schemas/tools.json /out/okf-tools.json
# The engine ships compiled into the image, so its notices go with it: okf-agent-memory (MIT) and the Go
# runtime, standard library and golang.org/x modules (Go's BSD license), which cover wasm_exec.js too.
RUN mkdir -p /licenses/okf-agent-memory /licenses/go \
 && cp LICENSE /licenses/okf-agent-memory/LICENSE \
 && cp "$(go env GOROOT)/LICENSE" /licenses/go/LICENSE

# Build: compile the TypeScript with the engine artifacts in place.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY --from=engine /out/okf-engine.wasm /out/wasm_exec.js ./src/engine/
COPY --from=engine /out/okf-tools.json ./src/okf-tools.json
RUN npm run build

# Runtime: production dependencies and dist/ only.
FROM node:22-slim
ENV NODE_ENV=production PORT=7878
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=engine /licenses ./licenses
USER 10001
EXPOSE 7878
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||7878)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
