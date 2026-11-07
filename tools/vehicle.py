"""Explicit, strictly verified SSH configuration; no bundled credentials."""
from pathlib import Path
import json
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]

class Remote:
    def __init__(self, config):
        host = os.environ.get('MGU_SSH_HOST') or config.get('host')
        user = os.environ.get('MGU_SSH_USER') or config.get('user', 'root')
        identity = os.environ.get('MGU_SSH_IDENTITY') or config.get('identityFile')
        hosts = os.environ.get('MGU_SSH_KNOWN_HOSTS') or config.get('knownHostsFile')
        if not all(isinstance(v, str) and v and not v.startswith('-') and not any(c in v for c in '\r\n') for v in [host, user, identity, hosts]):
            raise ValueError('Configure .local/vehicle.json or MGU_SSH_* variables')
        identity = Path(identity).expanduser()
        hosts = Path(hosts).expanduser()
        if not identity.is_file() or not hosts.is_file():
            raise ValueError('SSH identity and independently verified known-hosts file must exist')
        port = int(config.get('port', 22))
        if not 1 <= port <= 65535:
            raise ValueError('Invalid SSH port')
        self.command = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                        '-o', 'UserKnownHostsFile=' + str(hosts), '-o', 'IdentitiesOnly=yes',
                        '-o', 'ConnectTimeout=10', '-i', str(identity), '-p', str(port),
                        user + '@' + host]

    def run(self, command, timeout=30):
        return subprocess.run(self.command + [command], capture_output=True, timeout=timeout)

def connect():
    file = ROOT / '.local/vehicle.json'
    config = json.loads(file.read_text()) if file.exists() else {}
    return Remote(config)
