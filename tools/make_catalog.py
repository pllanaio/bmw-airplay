"""Write the Store catalog (schema 2) for a GitHub release of this repository."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

REPOSITORY = 'pllanaio/bmw-airplay'


def artifact(path, tag):
    data = path.read_bytes()
    return {'name': path.name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'url': 'https://github.com/%s/releases/download/%s/%s' % (REPOSITORY, tag, quote(path.name, safe=''))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', required=True)
    parser.add_argument('--app-version', required=True)
    parser.add_argument('--runtime-version', required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    dist = Path(args.dist)
    app = dist / ('pllana_airplay@%s.tgz' % args.app_version)
    runtime = dist / ('mgu-airplay@%s.tgz' % args.runtime_version)
    catalog = {'schema': 2, 'components': [
        {'id': 'mgu-airplay', 'kind': 'tool', 'title': 'AirPlay receiver runtime',
         'description': 'UxPlay receiver, video and BMW audio output for BMW AirPlay by pllana.io',
         'author': 'Leon Pllana IT-Solutions', 'version': args.runtime_version, 'artifact': artifact(runtime, args.tag),
         'requires': {'mgu-deploy': '0.7.17'}, 'uninstallable': True, 'mguHmi': ['ID7']},
        {'id': 'pllana_airplay', 'kind': 'app', 'title': 'BMW AirPlay by pllana.io',
         'description': 'iPhone screen mirroring and YouTube/AirPlay video on the iDrive display with BMW audio',
         'author': 'Leon Pllana IT-Solutions', 'version': args.app_version, 'artifact': artifact(app, args.tag),
         'requires': {'mgu-airplay': args.runtime_version, 'mgu-uplink': '0.7.3', 'mgu-render': '0.6.11', 'mgu-deploy': '0.7.17'},
         'uninstallable': True, 'mguHmi': ['ID7']},
    ]}
    (dist / 'catalog.json').write_text(json.dumps(catalog, indent=2) + '\n')
    print(json.dumps(catalog, indent=2))


if __name__ == '__main__':
    main()
