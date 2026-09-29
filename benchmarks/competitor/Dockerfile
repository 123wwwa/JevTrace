# Pinned jevgrep CLI for head-to-head retrieval runs. jevgrep supports macOS/Linux only, so it runs here.
FROM node:22-bookworm-slim
ARG JEVGREP_VERSION=0.7.0
RUN npm install --global "@dzhng/jevgrep@${JEVGREP_VERSION}" && jg --version
