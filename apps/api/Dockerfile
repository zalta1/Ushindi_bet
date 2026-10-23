FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci -w @ushindi/api
COPY apps/api apps/api
COPY db db
RUN npm run build -w @ushindi/api
ENV NODE_ENV=production
ENV MIGRATIONS_DIR=/app/db/migrations
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
