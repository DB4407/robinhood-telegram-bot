# Lightweight Node.js LTS Container
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package descriptors first for caching
COPY package*.json ./

# Install production dependencies (zero external deps required)
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Ensure data and config directories exist
RUN mkdir -p data config

# Expose internal healthcheck port
EXPOSE 10000

# Healthcheck endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:10000/ || exit 1

# Run autonomous trading bot
CMD ["node", "bot.js"]
