# Sweeter Side — menu site + admin.
# No dependencies to install: the server uses node:http, node:sqlite and
# node:crypto only. Node 22.5+ is required for node:sqlite.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Application code. Everything the server reads at runtime must be here.
COPY package.json ./
COPY server ./server
COPY admin ./admin
COPY templates ./templates
COPY scripts ./scripts
COPY assets ./assets
COPY index.html ./

# /data is the mount point for the persistent volume: the SQLite database and
# uploaded photos both live there. Without a volume mounted here, every deploy
# starts from an empty menu and loses uploaded photos.
RUN mkdir -p /data/uploads && chown -R node:node /data /app

USER node

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    DB_PATH=/data/app.db \
    UPLOAD_DIR=/data/uploads

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
