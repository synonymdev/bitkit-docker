FROM node:22.11.0-alpine3.20
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "provider.mjs"]
