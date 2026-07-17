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
# npm install plutôt que npm ci : le lockfile n'a pas pu être régénéré ici
# (pas de Node/npm dans l'environnement de développement de ce dépôt) après
# un changement de dépendances — npm ci exige une synchronie stricte
# lockfile/package.json que npm install n'impose pas.
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
