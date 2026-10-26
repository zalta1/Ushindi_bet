FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=5180
EXPOSE 5180
CMD ["node", "dist/index.js"]
