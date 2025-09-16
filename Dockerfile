# 1) Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# falls du Tailwind/Build-Schritt hast:
# RUN npm run build:css

# 2) Runtime stage (klein)
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app /app
# non-root user (optional)
RUN addgroup -S sf && adduser -S sf -G sf
USER sf
VOLUME ["/data"]
EXPOSE 8000
CMD ["node", "src/server.js"]
