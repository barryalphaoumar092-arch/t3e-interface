FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libreoffice-writer \
      fonts-liberation \
      fonts-liberation2 \
      fonts-dejavu-core \
      fontconfig && \
    fc-cache -fv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
