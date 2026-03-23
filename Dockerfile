FROM mcr.microsoft.com/playwright:v1.58.1-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY . .

EXPOSE ${PORT:-3847}

CMD ["node", "server.js"]
