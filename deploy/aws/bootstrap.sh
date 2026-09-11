#!/usr/bin/env bash
# EC2 user-data (Amazon Linux 2023): install Docker + the compose plugin, enable the daemon, and
# make an app dir. The image, compose file, Caddyfile and witness.env are shipped in afterwards.
set -euxo pipefail
dnf -y update
dnf -y install docker
systemctl enable --now docker
usermod -aG docker ec2-user
DOCKER_CONFIG=/usr/local/lib/docker
mkdir -p "$DOCKER_CONFIG/cli-plugins"
ARCH=$(uname -m); case "$ARCH" in aarch64) A=aarch64;; x86_64) A=x86_64;; *) A=$ARCH;; esac
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$A" \
  -o "$DOCKER_CONFIG/cli-plugins/docker-compose"
chmod +x "$DOCKER_CONFIG/cli-plugins/docker-compose"
mkdir -p /opt/klaxon/data && chown -R ec2-user:ec2-user /opt/klaxon
