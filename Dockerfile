FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
# Mount a persistent volume here: it holds the database, passkeys included.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
