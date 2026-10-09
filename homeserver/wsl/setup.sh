set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 python3-venv python3-pip ca-certificates curl >/dev/null
python3 --version
python3 -m venv /opt/synapse
/opt/synapse/bin/pip install -q --upgrade pip wheel
/opt/synapse/bin/pip install -q 'matrix-synapse[url-preview]'
/opt/synapse/bin/python -c "import synapse; print('synapse', synapse.__version__)"
mkdir -p /var/lib/synapse
echo SETUP_OK
