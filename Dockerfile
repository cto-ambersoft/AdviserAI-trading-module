FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# tsx is a devDependency, but we use it at runtime to execute TypeScript directly
RUN npm ci --include=dev


FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Default LibSQL storage location inside the container (writable)
ENV LIBSQL_URL=file:./data/trading.db

RUN mkdir -p /app/data && chown -R node:node /app/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src

EXPOSE 3001

USER node

# Recommended TSX integration for modern Node.js:
# https://github.com/privatenumber/tsx/blob/master/docs/dev-api/node-cli.md
CMD ["node", "--import", "tsx", "src/index.ts"]
