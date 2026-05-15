FROM docker:28-cli AS docker-cli

FROM python:3.13-slim

WORKDIR /app

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

COPY dockpilot ./dockpilot
COPY web ./web

ENV DOCKPILOT_HOST=0.0.0.0
ENV DOCKPILOT_PORT=8088

EXPOSE 8088

CMD ["python", "-m", "dockpilot.server"]
