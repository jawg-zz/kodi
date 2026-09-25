# Kodi web SPA -- build with: docker build -f apps/web/Dockerfile .
# Build-time args (Vite bakes these into the bundle -- mirror Dokploy build args):
#   --build-arg VITE_CONVEX_URL=...
#   --build-arg VITE_LOGTO_ISSUER=...
#   --build-arg VITE_LOGTO_APP_ID=...
#   [--build-arg VITE_APP_URL=...]

FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci

ARG VITE_CONVEX_URL
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL
ARG VITE_LOGTO_ISSUER
ENV VITE_LOGTO_ISSUER=$VITE_LOGTO_ISSUER
ARG VITE_LOGTO_APP_ID
ENV VITE_LOGTO_APP_ID=$VITE_LOGTO_APP_ID
ARG VITE_APP_URL
ENV VITE_APP_URL=$VITE_APP_URL

COPY . .
RUN npm run build -w apps/web

FROM nginx:stable-alpine AS production
COPY apps/web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
