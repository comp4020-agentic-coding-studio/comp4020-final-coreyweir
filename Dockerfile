# syntax = docker/dockerfile:1

# The client is built here, from app/ alone (the forks are vendored in
# app/vendor). The final image only serves app/dist and runs the node relays.

FROM docker.io/library/node:24-slim AS client
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
COPY app/vendor/ ./vendor/
RUN npm ci --no-audit --no-fund
COPY app/ ./
RUN npm run build

FROM docker.io/library/node:24-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx-light \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/server
COPY app/server/package.json app/server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY app/server/*.mjs ./

COPY --from=client /build/app/dist/ /srv/www/
COPY placeholder/readme.html README.md /tmp/readme/
# README.md goes into the page HTML-escaped, in place of @README@
RUN mkdir -p /srv/www/readme \
    && sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' /tmp/readme/README.md > /tmp/readme/body \
    && sed -e '/@README@/{r /tmp/readme/body' -e 'd}' /tmp/readme/readme.html > /srv/www/readme/index.html

COPY deploy/nginx.conf /srv/nginx.conf
COPY deploy/start.sh /srv/start.sh

ENV RIFF_DB=/data/riff.sqlite
EXPOSE 8080
CMD ["bash", "/srv/start.sh"]
