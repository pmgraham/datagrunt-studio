# Build stage: install all deps (next build needs devDependencies) and build.
FROM node:22-alpine AS builder

WORKDIR /build
# package-lock.json is committed (app convention, #18); the glob tolerates
# older checkouts that predate it.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Runtime stage: standalone server only (~ the .next/standalone tree).
FROM node:22-alpine

WORKDIR /srv
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /build/.next/standalone ./
COPY --from=builder --chown=node:node /build/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
