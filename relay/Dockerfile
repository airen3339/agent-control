FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY relay-server.mjs ./
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
