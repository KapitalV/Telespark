#!/usr/bin/env bash
# Read-only inventory. Does not read credentials, install packages or start bots.
set -euo pipefail
uname -m
cat /etc/os-release
nproc
free -h
lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS
df -h / /dev/shm
id
if command -v node >/dev/null; then node --version; fi
if command -v npm >/dev/null; then npm --version; fi
if command -v git >/dev/null; then git --version; fi
if command -v systemctl >/dev/null; then systemctl --version | head -n 1; fi
