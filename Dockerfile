FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
ENV PORT=3000 DATA_DIR=/app/data NODE_ENV=production TZ=Asia/Shanghai
EXPOSE 3000
VOLUME ["/app/data"]
USER node
CMD ["node", "src/launcher.js"]
