FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
RUN addgroup -S nox && adduser -S nox -G nox

COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN chown -R nox:nox /app
USER nox

EXPOSE 3099

CMD ["node", "src/unified-server.js"]
