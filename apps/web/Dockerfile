ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps/web apps/web

# Vite bakes VITE_* variables into the bundle at BUILD time; passing this as a
# runtime environment variable to the nginx container has no effect. The release
# image defaults to same-origin API calls so it can run behind nginx/Caddy or
# GHCR without rebuilding for a specific hostname.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

WORKDIR /app/apps/web
RUN npm run build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
