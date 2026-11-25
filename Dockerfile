# Servidor de sinalização + página do visualizador, numa imagem pequena.
# Render, Fly.io ou qualquer VPS com Docker. A porta vem de $PORT (Render/Fly definem sozinhos).

# 1) compilação
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY protocol/package.json protocol/
COPY signaling/package.json signaling/
COPY web-client/package.json web-client/
RUN npm ci
COPY protocol protocol
COPY signaling signaling
COPY web-client web-client
RUN npm run build -w web-client && npm run build -w signaling

# 2) execução: só o servidor empacotado (um arquivo) e a página estática
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 TRUST_PROXY=1
COPY --from=build /app/signaling/dist/main.js signaling/dist/main.js
COPY --from=build /app/web-client/dist web-client/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "signaling/dist/main.js"]
