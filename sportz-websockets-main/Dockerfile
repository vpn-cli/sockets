# Backend Dockerfile for Sportz Express & WebSocket Server
FROM node:20-alpine AS runner

WORKDIR /app

# Install dependencies based on package.json
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source code
COPY . .

# Expose HTTP & WebSocket port
EXPOSE 8000

ENV PORT=8000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8000/health || exit 1

CMD ["node", "src/index.js"]
