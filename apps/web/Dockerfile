# Kodi web SPA -- build with: docker build -f apps/web/Dockerfile .
# Build-time args (Vite bakes these into the bundle -- mirror Dokploy build args):
#   --build-arg VITE_CONVEX_URL=...

FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci

ARG VITE_CONVEX_URL
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL

COPY . .
RUN npm run build -w apps/web

FROM nginx:stable-alpine AS production
COPY apps/web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
