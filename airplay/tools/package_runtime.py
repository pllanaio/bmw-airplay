"""Pack the built runtime (.build/airplay/runtime) as an MGU Store tool kit.

The kit is not bound to a UID: airplay/runtime/launch.js finds the app's UID
on the head unit. Output: dist/pllana-airplay-receiver@<version>.tgz, reproducible
(sorted members, owner 0:0, fixed mtime, gzip mtime 0).
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.build/airplay/runtime'
TOOL = 'pllana-airplay-receiver'
UNIT = TOOL + '.service'
MTIME = int(os.environ.get('SOURCE_DATE_EPOCH', '1767225600'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def collect():
    manifest = json.loads((RUNTIME / 'build-manifest.json').read_text())
    entries = []
    for name, proof in sorted(manifest['files'].items()):
        data = (RUNTIME / name).read_bytes()
        if sha(data) != proof['sha256']:
            raise SystemExit('runtime_input_changed: ' + name)
        mode = 0o755 if name.startswith('bin/') or name == 'lib/ld-linux-x86-64.so.2' else 0o644
        entries.append(('runtime/' + name, data, mode))
    entries.append(('runtime/build-manifest.json', (RUNTIME / 'build-manifest.json').read_bytes(), 0o644))
    for name, mode in [('launch.js', 0o644), ('activate.js', 0o644), ('deactivate.js', 0o644), ('p2p_probe.js', 0o644), ('check.sh', 0o755)]:
        entries.append((name, (ROOT / 'airplay/runtime' / name).read_bytes(), mode))
    entries.append(('network.js', (ROOT / 'airplay/network.js').read_bytes(), 0o644))
    for name in ['LICENSE', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md']:
        entries.append((name, (ROOT / name).read_bytes(), 0o644))
    return manifest, entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--out', default=str(ROOT / 'dist'))
    args = parser.parse_args()
    manifest, entries = collect()
    if manifest.get('version') != args.version:
        raise SystemExit('Runtime build version %s differs from %s' % (manifest.get('version'), args.version))
    unit = (ROOT / 'airplay/runtime' / UNIT).read_bytes()
    component = {
        'id': TOOL, 'kind': 'tool', 'version': args.version,
        'title': 'PllanaCast for BMW receiver runtime',
        'description': 'UxPlay receiver with GStreamer video/HLS and SmartX audio for PllanaCast for BMW',
        'mguHmi': ['ID7'], 'uninstallable': True,
        'requires': {'mgu-deploy': '0.7.17'},
        # Take over from (and on removal give back to) the older private
        # mgu-airplay runtime, which the Store can neither replace nor remove.
        'activate': ['node', 'activate.js'], 'deactivate': ['node', 'deactivate.js'],
        'files': [{'path': n, 'mode': format(m, '04o'), 'sha256': sha(b)} for n, b, m in entries],
        'units': [{'name': UNIT}],
        'enable': [{'unit': UNIT, 'target': 'multi-user.target'}],
        'restart': [UNIT], 'check': ['check.sh'],
        'crashNames': ['mgu-airplay', 'uxplay', 'airplay-launch', 'airplay-backend-launch'],
    }
    members = [('component.json', json.dumps(component, indent=2).encode() + b'\n', 0o644),
               ('units/' + UNIT, unit, 0o644)] + [('files/' + n, b, m) for n, b, m in entries]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    artifact = out / (TOOL + '@' + args.version + '.tgz')
    with artifact.open('wb') as raw, gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0) as zipped, \
            tarfile.open(fileobj=zipped, mode='w', format=tarfile.GNU_FORMAT) as archive:
        for name, data, mode in sorted(members):
            item = tarfile.TarInfo(name)
            item.size, item.mode, item.mtime = len(data), mode, MTIME
            item.uid = item.gid = 0
            item.uname = item.gname = 'root'
            archive.addfile(item, io.BytesIO(data))
    print(json.dumps({'artifact': str(artifact), 'bytes': artifact.stat().st_size, 'sha256': sha(artifact.read_bytes()), 'files': len(entries)}))


if __name__ == '__main__':
    main()
