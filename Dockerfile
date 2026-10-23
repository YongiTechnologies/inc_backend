# Image for running the API as a normal long-lived server (node server.js),
# used by deploy/hetzner/docker-compose.yml. Netlify does not use this file.
FROM node:22-alpine

WORKDIR /app

# Install production deps first so this layer caches across code changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 5000

# Drop root; the node image ships an unprivileged "node" user.
USER node

CMD ["node", "server.js"]
