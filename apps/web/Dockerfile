FROM node:20-alpine AS b
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx vite build
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=b /app/dist /usr/share/nginx/html
EXPOSE 80
