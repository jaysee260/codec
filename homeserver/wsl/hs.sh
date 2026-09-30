#!/usr/bin/env bash
# Synapse in a WSL1 distro (fallback for machines without virtualization / Docker).
# Usage from Windows Git Bash or PowerShell: bash homeserver/wsl/hs.sh {install|start|stop|restart|status|reset|logs}
set -euo pipefail
DISTRO=matrix-hs
HERE="$(cd "$(dirname "$0")" && pwd)"
W() { MSYS_NO_PATHCONV=1 wsl.exe -d "$DISTRO" -- "$@"; }
mnt() { # convert C:/x or /c/x to /mnt/c/x
  local p="$1"; p="${p//\\//}"; p="$(echo "$p" | sed -E 's#^([A-Za-z]):/#/mnt/\L\1/#; s#^/([a-z])/#/mnt/\1/#')"; echo "$p"; }
case "${1:-status}" in
  install)
    ROOTFS="${2:-$HOME/wsl/dl/rootfs.tar.gz}"
    [ -f "$ROOTFS" ] || { echo "need a Debian rootfs tarball at $ROOTFS (see README.md)"; exit 1; }
    wsl.exe --import "$DISTRO" "$USERPROFILE\wsl\$DISTRO" "$(cygpath -w "$ROOTFS")" --version 1
    W bash "$(mnt "$HERE/setup.sh")"
    W bash "$(mnt "$HERE/configure.sh")" ;;
  start|restart) W bash "$(mnt "$HERE/configure.sh")" ;;
  stop)   W /opt/synapse/bin/synctl stop /var/lib/synapse/homeserver.yaml ;;
  status) curl -s -m 5 http://localhost:8008/_matrix/client/versions >/dev/null && echo "synapse: up (http://localhost:8008)" || echo "synapse: down" ;;
  logs)   W tail -n "${2:-100}" /var/lib/synapse/homeserver.log ;;
  reset)  # wipe database + media, keep config, restart
    W /opt/synapse/bin/synctl stop /var/lib/synapse/homeserver.yaml || true
    W bash -c 'rm -f /var/lib/synapse/homeserver.db* && rm -rf /var/lib/synapse/media_store'
    W bash "$(mnt "$HERE/configure.sh")" ;;
  *) echo "usage: $0 {install|start|stop|restart|status|reset|logs}"; exit 1 ;;
esac
