set -euo pipefail
cd /var/lib/synapse
if [ ! -f homeserver.yaml ]; then
  /opt/synapse/bin/python -m synapse.app.homeserver --server-name localhost --config-path /var/lib/synapse/homeserver.yaml --generate-config --report-stats=no --data-directory /var/lib/synapse >/dev/null
fi
/opt/synapse/bin/python - <<'PY'
import yaml
p='/var/lib/synapse/homeserver.yaml'
c=yaml.safe_load(open(p))
c['enable_registration']=True
c['enable_registration_without_verification']=True
c['presence']={'enabled':True}
c['suppress_key_server_warning']=True
c['enable_authenticated_media']=False
c['url_preview_enabled']=True
c['url_preview_ip_range_blacklist']=['127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10','192.0.0.0/24','169.254.0.0/16','192.88.99.0/24','198.18.0.0/15','192.0.2.0/24','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','::1/128','fe80::/10','fc00::/7','2001:db8::/32','ff00::/8','fec0::/10']
c['url_preview_accept_language']=['en-US','en']
c['max_spider_size']='10M'
big={'per_second':1000,'burst_count':10000}
for k in ['rc_message','rc_registration','rc_login','rc_joins','rc_invites','rc_admin_redaction','rc_3pid_validation','rc_room_creation']:
    if k=='rc_login':
        c[k]={'address':big,'account':big,'failed_attempts':big}
    elif k=='rc_joins':
        c[k]={'local':big,'remote':big}
    elif k=='rc_invites':
        c[k]={'per_room':big,'per_user':big,'per_issuer':big}
    else:
        c[k]=big
c['rc_joins_per_room']=big
for l in c.get('listeners',[]):
    if l.get('port')==8008:
        l['bind_addresses']=['::1','127.0.0.1']
c['experimental_features']={'msc3575_enabled':True}
yaml.safe_dump(c,open(p,'w'),sort_keys=False)
print('config patched')
PY
grep -nE 'enable_registration|presence|server_name|bind_addresses|^rc_message' homeserver.yaml | head -8
/opt/synapse/bin/synctl restart /var/lib/synapse/homeserver.yaml 2>&1 | tail -3 || /opt/synapse/bin/synctl start /var/lib/synapse/homeserver.yaml 2>&1 | tail -3
sleep 4
curl -s -m 5 http://127.0.0.1:8008/_matrix/client/versions | head -c 200; echo
echo CONFIG_OK
