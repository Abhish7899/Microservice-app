# Multi-stage / lightweight production Dockerfile
FROM node:20-alpine

# Set deployment environment
ENV NODE_ENV=production

# Set working directory
WORKDIR /app

# Create explicit non-root system group and user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Install dependencies with production flag
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source code with proper ownership
COPY --chown=appuser:appgroup . .

# Switch to non-root user
USER appuser

# Expose service port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start service
CMD ["node", "src/index.js"]
