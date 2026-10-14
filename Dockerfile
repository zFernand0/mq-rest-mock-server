# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Fernando Rijo Cedeno
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=9080
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node src ./src
USER node
EXPOSE 9080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"
CMD ["node", "server.js"]
