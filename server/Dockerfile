FROM node:20-alpine
WORKDIR /usr/src/app
# The PR reviewer pipeline shells out to git.
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]
