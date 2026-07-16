FROM node:22-bookworm

RUN apt-get update && \
    apt-get install -y \
      libreoffice-writer \
      fonts-liberation \
      fonts-liberation2 \
      fonts-dejavu-core \
      fontconfig && \
    fc-cache -fv && \
    rm -rf /var/lib/apt/lists/*

# Vérifier que LibreOffice démarre — si cette ligne échoue, le build échoue
# et les logs Render montrent l'erreur exacte
RUN soffice --headless --version

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Chromium pour le scraper SEAO (src/services/seao-scraper.js) — le site SEAO
# est une application JavaScript qui nécessite un vrai navigateur avec session
# (voir project_seao... : une requête HTTP simple retourne une page vide).
# Ce navigateur ne tourne que sur ce service Render, jamais sur Vercel.
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
