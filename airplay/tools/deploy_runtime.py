"""Versioned, non-root receiver service installed with the existing MGU Deploy."""
from pathlib import Path
import hashlib
import io
import json
import re
import shlex
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from vehicle import connect

remote = connect()
query = r'''const f=require('fs'),r=JSON.parse(f.readFileSync('/var/opt/public/oap/oap_12201/data/apps/pllana_airplay.json','utf8')),p=JSON.parse(f.readFileSync('/var/opt/public/oap/oap_'+r.userId+'/source/package.json','utf8'));if(p.name!=='pllana_airplay')throw Error('unexpected_app');console.log(JSON.stringify({uid:r.userId,version:p.version}));'''
result = subprocess.run(remote.command + ['exec /usr/bin/node -e ' + shlex.quote(query)], capture_output=True, timeout=12)
if result.returncode:
    print(result.stderr.decode('utf8', 'replace')[-1000:]); raise SystemExit('app_lookup_failed')
uid = json.loads(result.stdout)['uid']
if json.loads(result.stdout)['version'] != json.loads((ROOT / 'dist/airplay-build-provenance.json').read_text())['version']:
    raise SystemExit('installed_app_version_mismatch')
if not isinstance(uid, int) or not 12203 <= uid <= 65535:
    raise SystemExit('unexpected_app_uid')
state_file = ROOT / '.local/airplay/app-install.json'
state = json.loads(state_file.read_text()); state.update(uid=uid, status='app_installed_backend_pending')
state_file.write_text(json.dumps(state, indent=2))
home = '/var/opt/public/oap/oap_' + str(uid)
unit = '''[Unit]
Description=Private BMW AirPlay receiver
After=persistency-fs.target alsaroutingadapters.service mdnsd.service mgu-uplink.service
Wants=persistency-fs.target

[Service]
Type=simple
User=root
Group=root
ExecStart=/var/opt/mgu-airplay/current/runtime/bin/airplay-backend-launch {uid}
ExecStartPre=/usr/bin/node /var/opt/mgu-airplay/current/network.js apply {uid}
ExecStopPost=/usr/bin/node /var/opt/mgu-airplay/current/network.js remove
WorkingDirectory={home}/data
Environment=MGU_AIRPLAY_RUNTIME=/var/opt/mgu-airplay/current/runtime
Environment=HOME={home}/data
NoNewPrivileges=yes
Restart=always
RestartSec=2
KillMode=control-group
TimeoutStopSec=15
MemoryAccounting=yes
MemoryLimit=1G
CPUAccounting=yes
CPUShares=1024
Nice=-5
TasksMax=256
OOMScoreAdjust=0
UMask=0077

[Install]
WantedBy=multi-user.target
'''.format(uid=uid, home=home).encode()
check = '''#!/bin/sh
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for file in "{home}"/source/javascript/*.js; do /usr/bin/node --check "$file"; done
"$BASE/runtime/lib/ld-linux-x86-64.so.2" --library-path "$BASE/runtime/lib" --list "$BASE/runtime/bin/uxplay" >/dev/null
test -f "$BASE/runtime/plugins/libgstalsa.so"
test ! -e "$BASE/runtime/lib/libasound.so.2"
echo "AirPlay Node-8 syntax and private ELF runtime verified"
"$BASE/runtime/bin/airplay-backend-launch" {uid} --check
'''.format(home=home, uid=uid).encode()
runtime = ROOT / '.build/airplay/runtime'
manifest = json.loads((runtime / 'build-manifest.json').read_text())
sha = lambda b: hashlib.sha256(b).hexdigest()
entries = [('check.sh', check, 0o755), ('network.js', (ROOT / 'airplay/network.js').read_bytes(), 0o644)]
for name, proof in manifest['files'].items():
    data = (runtime / name).read_bytes()
    if sha(data) != proof['sha256']:
        raise SystemExit('runtime_input_changed: ' + name)
    mode = 0o755 if name.startswith('bin/') or name == 'lib/ld-linux-x86-64.so.2' else 0o644
    entries.append(('runtime/' + name, data, mode))
entries.append(('runtime/build-manifest.json', (runtime / 'build-manifest.json').read_bytes(), 0o644))
component = {
    'id': 'mgu-airplay', 'kind': 'tool', 'version': '0.3.1', 'title': 'Private AirPlay receiver runtime',
    'description': 'UxPlay and SmartX audio, non-root service for pllana_airplay UID ' + str(uid),
    'internet': True, 'uids': [uid],
    'mguHmi': ['ID7'], 'files': [{'path': n, 'mode': format(m, '04o'), 'sha256': sha(b)} for n, b, m in entries],
    'units': [{'name': 'mgu-airplay.service'}],
    'enable': [{'unit': 'mgu-airplay.service', 'target': 'multi-user.target'}],
    'restart': ['mgu-airplay.service'], 'check': ['check.sh'],
    'crashNames': ['mgu-airplay', 'uxplay', 'airplay-launch', 'airplay-backend-launch'],
    'uninstallable': True,
}
artifact = ROOT / 'dist/mgu-airplay@0.3.1.tgz'
with tarfile.open(artifact, 'w:gz', compresslevel=1) as archive:
    for name, data, mode in [('component.json', json.dumps(component, indent=2).encode(), 0o644),
                             ('units/mgu-airplay.service', unit, 0o644)] + [('files/' + n, b, m) for n, b, m in entries]:
        item = tarfile.TarInfo(name); item.size = len(data); item.mode = mode; item.uid = item.gid = 0
        archive.addfile(item, io.BytesIO(data))
stage = state['stage']
if not re.fullmatch('/var/opt/pllana-airplay-stage-[A-Za-z0-9]{6}', stage):
    raise SystemExit('invalid_staging_directory')
target = stage + '/' + artifact.name
expected = sha(artifact.read_bytes())
print('Transfer versioned runtime:', artifact.stat().st_size, 'bytes; service UID', uid, flush=True)
with artifact.open('rb') as stream:
    r = subprocess.run(remote.command + ['umask 077; cat > ' + shlex.quote(target)], stdin=stream, capture_output=True, timeout=90)
if r.returncode:
    raise SystemExit('runtime_transfer_failed')
verify = 'if(require("crypto").createHash("sha256").update(require("fs").readFileSync(' + json.dumps(target) + ')).digest("hex")!==' + json.dumps(expected) + ')throw Error("runtime_transfer_hash");'
subprocess.run(remote.command + ['exec /usr/bin/node -e ' + shlex.quote(verify)], check=True, timeout=15)
state.update(runtime_sha256=expected, runtime_artifact=target)
for action in ['check', 'install'] if '--install' in sys.argv else ['check']:
    print('MGU Deploy runtime:', action, flush=True)
    cmd = 'sh /var/opt/mgu-deploy/mgu-deploy.sh ' + action + ' --artifact ' + shlex.quote(target) + (' --yes' if action == 'install' else '')
    with (ROOT / ('.local/airplay/runtime-' + action + '.log')).open('w', encoding='utf8') as log:
        p = subprocess.Popen(remote.command + [cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf8', errors='replace')
        for line in p.stdout:
            print(line, end='', flush=True); log.write(line); log.flush()
        code = p.wait()
    state['status'] = 'runtime_' + action + ('_passed' if code == 0 else '_failed')
    state_file.write_text(json.dumps(state, indent=2))
    if code:
        raise SystemExit(code)
print('Runtime deployment complete; iPhone test pending', flush=True)
