# Web image. Mirrors game-is-up's apps/web/Dockerfile: build the SPA
# with Node, then ship a self-contained nginx-unprivileged runtime
# with the printstream-specific nginx config baked in. Listens on 8080
# as a non-root user.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG BUILD_VITE_API_BASE_URL
ARG BUILD_VITE_DOMAIN_MIGRATION_TARGET
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
RUN npm ci
COPY . .
RUN if [ -n "$BUILD_VITE_API_BASE_URL" ]; then export VITE_API_BASE_URL="$BUILD_VITE_API_BASE_URL"; fi \
 && if [ -n "$BUILD_VITE_DOMAIN_MIGRATION_TARGET" ]; then export VITE_DOMAIN_MIGRATION_TARGET="$BUILD_VITE_DOMAIN_MIGRATION_TARGET"; fi \
 && npm run build --workspace @printstream/shared \
 && npm run build --workspace @printstream/web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
