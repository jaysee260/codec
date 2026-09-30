# Synapse without Docker (WSL1 fallback)

Use this when Docker Desktop cannot run (no CPU virtualization, e.g. SVM disabled in BIOS).
WSL1 needs no virtualization. Synapse runs from a Python venv inside a throwaway Debian distro
named `matrix-hs` and listens on http://localhost:8008, same as the Docker path.

| Command | What it does |
|---|---|
| `bash homeserver/wsl/hs.sh install [rootfs.tar.gz]` | import Debian rootfs as WSL1 distro, install Synapse, write config, start |
| `bash homeserver/wsl/hs.sh start` / `stop` / `restart` | control the server |
| `bash homeserver/wsl/hs.sh status` | curl the versions endpoint |
| `bash homeserver/wsl/hs.sh reset` | wipe DB + media, keep config, restart (then `npm run seed`) |
| `bash homeserver/wsl/hs.sh logs [n]` | tail homeserver.log |

Rootfs: the `library/debian:bookworm` amd64 layer from Docker Hub (a plain tar.gz), saved to `~/wsl/dl/rootfs.tar.gz`.
Config lives inside the distro at `/var/lib/synapse/homeserver.yaml`; `configure.sh` applies the same settings as the
Docker `homeserver.yaml` (open registration without verification, relaxed `rc_*` limits, presence on, SQLite).

To remove: `wsl --unregister matrix-hs`.
