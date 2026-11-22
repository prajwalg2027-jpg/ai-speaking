# The Sakhi server for Google Cloud Run. Small Node image, production dependencies only, runs as a non-root user.
# The official Node image via Google's Docker Hub mirror (no Docker Hub pull limits in Cloud Build).
FROM mirror.gcr.io/library/node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg compresses voice recordings to Opus (server/recordings.js).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY public ./public
USER node
# Cloud Run sets PORT (8080); the server reads it.
EXPOSE 8080
CMD ["node", "server/index.js"]
