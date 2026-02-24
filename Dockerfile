# Profile Generation Agent - Docker image

FROM python:3.11-slim

# Add metadata
LABEL maintainer="RAKwireless IoT Automation" \
      version="1.0" \
      description="BACnet Profile Generation Agent"

WORKDIR /workspace

# Install Node.js and Python dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY automation/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy all project files
COPY . .

# Set up entrypoint (must be done as root)
COPY automation/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create non-root user
RUN groupadd -r agent && useradd -r -g agent -m agent
RUN chown -R agent:agent /workspace
USER agent

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import sys; sys.exit(0)"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["--help"]
