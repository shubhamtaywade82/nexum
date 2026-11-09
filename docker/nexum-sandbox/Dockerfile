FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ripgrep build-essential \
    && rm -rf /var/lib/apt/lists/*

# Add language toolchains here only as the repos this agent operates
# on actually need them (ruby, python3, etc.) — keep this minimal,
# it's the blast radius for anything a model-issued command runs.

WORKDIR /workspace

# Model-issued commands run as this unprivileged user. The shell tool also passes the host uid at run time
# (--user), which takes precedence. An image built FROM this one whose RUN steps need root must say so
# with its own `USER root` line.
USER node
