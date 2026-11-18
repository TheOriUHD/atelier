# The App Review demo server: the release's own server image with the demo's data and the demo model added.
# Build it from this folder after scripts/seed.mjs has made build/data (README.md); `wrangler deploy` does.
FROM --platform=linux/amd64 ghcr.io/theoriuhd/atelier:v0.10.2

# Not /data: a container starts from this image's disk every time it wakes, so the demo always begins as it was made, and
# start.sh puts a copy where the server keeps its data.
COPY --chown=atelier:atelier build/data/ /demo-data/
COPY --chown=atelier:atelier container/demo-model.mjs /app/demo-model.mjs
COPY --chown=atelier:atelier --chmod=0755 container/start.sh /app/start.sh

# Bumped to make a new container start (it reads the Worker's secrets only when it starts).
LABEL org.atelierhq.demo.revision="4"

CMD ["/app/start.sh"]
