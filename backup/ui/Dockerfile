# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY ui/package.json ui/package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y nano && rm -rf /var/lib/apt/lists/*

COPY ui/.env.local /app

COPY --from=deps /app/node_modules ./node_modules
COPY ui/ ./

# These are used by Next.js rewrites during `npm run build` (server-side proxy destinations).
ARG INTERNAL_API_URL
ARG INTERNAL_CODE_BUILDER_API_URL
ENV INTERNAL_API_URL=$INTERNAL_API_URL \
    INTERNAL_CODE_BUILDER_API_URL=$INTERNAL_CODE_BUILDER_API_URL

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Keep these available at runtime too (useful if Next.js reads them on boot).
ARG INTERNAL_API_URL
ARG INTERNAL_CODE_BUILDER_API_URL
ENV INTERNAL_API_URL=$INTERNAL_API_URL \
    INTERNAL_CODE_BUILDER_API_URL=$INTERNAL_CODE_BUILDER_API_URL

# Next.js standalone output
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

CMD ["node", "server.js"]
