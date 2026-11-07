"""Install this exact private build through the existing MGU Deploy installer."""
from pathlib import Path
import hashlib
import json
import re
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from vehicle import connect

record = json.loads((ROOT / 'dist/airplay-build-provenance.json').read_text())
artifact = ROOT / ('dist/pllana_airplay@' + record['version'] + '.mgu')
if hashlib.sha256(artifact.read_bytes()).hexdigest() != record['app_sha256']:
    raise SystemExit('build_manifest_mismatch')
remote = connect()
created = subprocess.run(remote.command + ['umask 077; mktemp -d /var/opt/pllana-airplay-stage-XXXXXX'], capture_output=True, timeout=12)
stage = created.stdout.decode().strip()
if created.returncode or not re.fullmatch('/var/opt/pllana-airplay-stage-[A-Za-z0-9]{6}', stage):
    raise SystemExit('private_staging_failed')
target = stage + '/' + artifact.name
print('Transfer small OAP package:', artifact.stat().st_size, 'bytes', flush=True)
with artifact.open('rb') as stream:
    result = subprocess.run(remote.command + ['umask 077; cat > ' + shlex.quote(target)], stdin=stream, capture_output=True, timeout=30)
if result.returncode:
    raise SystemExit('artifact_transfer_failed')
verify = ('const f=require("fs"),c=require("crypto");if(c.createHash("sha256").update(f.readFileSync(' + json.dumps(target) + ')).digest("hex")!==' + json.dumps(record['app_sha256']) + ')throw Error("artifact_hash_mismatch");')
subprocess.run(remote.command + ['exec /usr/bin/node -e ' + shlex.quote(verify)], check=True, timeout=10)
state = dict(record, stage=stage, artifact=target, status='staged')
state_file = ROOT / '.local/airplay/app-install.json'
state_file.write_text(json.dumps(state, indent=2))
for action in ['check', 'install'] if '--install' in sys.argv else ['check']:
    command = 'sh /var/opt/mgu-deploy/mgu-deploy.sh ' + action + ' --artifact ' + shlex.quote(target) + (' --yes' if action == 'install' else '')
    print('MGU Deploy:', action, flush=True)
    with (ROOT / ('.local/airplay/app-' + action + '.log')).open('w', encoding='utf8') as log:
        p = subprocess.Popen(remote.command + [command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf8', errors='replace')
        for line in p.stdout:
            print(line, end='', flush=True); log.write(line); log.flush()
        code = p.wait()
    if code:
        state['status'] = action + '_failed'; state_file.write_text(json.dumps(state, indent=2))
        raise SystemExit(code)
    state['status'] = action + '_passed'; state_file.write_text(json.dumps(state, indent=2))
if '--install' in sys.argv:
    query = 'const f=require("fs"),p="/var/opt/public/oap/oap_12201/data/apps/pllana_airplay.json",r=JSON.parse(f.readFileSync(p,"utf8"));console.log(JSON.stringify({uid:r.userId}));'
    result = subprocess.run(remote.command + ['exec /usr/bin/node -e ' + shlex.quote(query)], capture_output=True, timeout=12)
    if result.returncode:
        raise SystemExit('cannot_read_installed_app_uid')
    uid = json.loads(result.stdout)['uid']
    if not isinstance(uid, int) or not 12203 <= uid <= 65535:
        raise SystemExit('unexpected_app_uid')
    state.update(uid=uid, status='app_installed_backend_pending')
    state_file.write_text(json.dumps(state, indent=2))
    print('Installed AirPlay app UID:', uid, flush=True)
