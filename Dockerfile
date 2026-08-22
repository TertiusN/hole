FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
# world state lives on the mounted volume, never in the image
ENV HOLE_DATA=/data
EXPOSE 3013
CMD ["node", "server.js"]
