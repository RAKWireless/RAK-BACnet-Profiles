FROM node:20-bookworm-slim

LABEL maintainer="RAKwireless IoT Automation" \
      version="2.0" \
      description="BACnet Profile Automation"

WORKDIR /workspace

COPY --chown=node:node scripts/package*.json /workspace/scripts/
COPY --chown=node:node automation/package*.json /workspace/automation/

RUN npm ci --prefix /workspace/scripts --omit=dev --ignore-scripts \
    && npm ci --prefix /workspace/automation --omit=dev --ignore-scripts

COPY --chown=node:node . /workspace

USER node

ENTRYPOINT ["node", "automation/src/cli.js"]
CMD ["help"]
