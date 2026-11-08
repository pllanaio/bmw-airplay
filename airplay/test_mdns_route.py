#!/usr/bin/env python3
"""Real policy-routing checks, exclusively inside a fresh network namespace."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def run(args, expected=0):
    result = subprocess.run([str(value) for value in args], text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=10)
    assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
    return result.stdout


def inside(binary):
    ip = shutil.which('ip')
    assert ip, 'iproute2 is required only for the isolated test fixture'
    for name in ['ap0', 'wlan1']:
        run([ip, 'link', 'add', name, 'type', 'veth', 'peer', 'name', name + '-peer'])
        run([ip, 'link', 'set', name, 'up'])
        run([ip, 'link', 'set', name + '-peer', 'up'])
    run([ip, 'address', 'add', '192.168.43.1/24', 'dev', 'ap0'])
    run([ip, 'address', 'add', '172.20.10.2/28', 'dev', 'wlan1', 'noprefixroute'])
    run([ip, 'route', 'add', 'default', 'via', '192.168.43.254', 'dev', 'ap0'])
    run([ip, 'route', 'add', 'table', '110', '172.20.10.0/28', 'dev', 'wlan1', 'src', '172.20.10.2'])
    run([ip, 'route', 'add', 'table', '110', 'default', 'via', '172.20.10.1', 'dev', 'wlan1', 'onlink'])

    def route(address, uid):
        return run([ip, 'route', 'get', address, 'uid', uid])

    mappings = [tuple(map(int, line.split())) for line in Path('/proc/self/uid_map').read_text().splitlines()]
    def mapped(uid):
        return any(first <= uid < first + count for first, outside, count in mappings)
    uids = [0, 65534] if mapped(65534) else [0]

    assert 'dev ap0' in route('172.20.10.1', 0), 'wildcard mDNS replies initially choose the BMW route'
    for uid in uids:
        run([binary, 'add', uid, '172.20.10.0', 28])
    run([binary, 'add', 0, '172.20.10.0', 28], expected=72)
    status = json.loads(run([binary, 'show']))
    assert status['foreign'] is False and len(status['rules']) == len(uids)
    for uid in uids:
        assert 'dev wlan1' in route('172.20.10.1', uid) and 'src 172.20.10.2' in route('172.20.10.1', uid)
        assert 'dev ap0' in route('1.1.1.1', uid), 'the daemon receives no general Internet routing'
        assert 'dev ap0' in route('192.168.43.42', uid), 'BMW AP routing remains intact'
    if mapped(13007):
        assert 'dev ap0' in route('172.20.10.1', 13007), 'another UID receives no policy exception'
    run([ip, 'route', 'delete', 'table', '110', '172.20.10.0/28'])
    assert 'dev ap0' in route('172.20.10.1', 0), 'a default-only uplink table is suppressed'
    run([ip, 'route', 'add', 'table', '110', '172.20.10.0/28', 'dev', 'wlan1', 'src', '172.20.10.2'])
    run([binary, 'delete', 0, '172.20.10.0', 28])
    run([binary, 'delete', 0, '172.20.10.0', 28])
    assert 'dev ap0' in route('172.20.10.1', 0)
    if 65534 in uids:
        assert 'dev wlan1' in route('172.20.10.1', 65534)
    run([ip, 'rule', 'add', 'priority', '1099', 'to', '10.55.0.0/16', 'table', '120'])
    assert json.loads(run([binary, 'show']))['foreign'] is True, 'a colliding foreign rule is reported'
    if 65534 in uids:
        run([binary, 'delete', 65534, '172.20.10.0', 28])
    status = json.loads(run([binary, 'show']))
    assert status['foreign'] is True and status['rules'] == []
    assert '10.55.0.0/16 lookup 120' in run([ip, 'rule', 'show']), 'exact cleanup preserves the foreign rule'
    print('Bonjour route helper: isolated hotspot source selection, no Internet grant, default suppression and foreign-rule preservation passed (UIDs %s)' % uids)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--inside', action='store_true')
    parser.add_argument('--cli-only', action='store_true', help='explicitly run parser/privilege checks without a network namespace')
    args = parser.parse_args()
    if args.inside:
        inside(args.binary.resolve())
        return
    with tempfile.TemporaryDirectory(prefix='airplay-mdns-route-test-') as directory:
        binary = args.binary.resolve() if args.binary else Path(directory) / 'mdns-route'
        if not args.binary:
            run(['gcc', '-static', '-O2', '-Wall', '-Wextra', '-Werror',
                 Path(__file__).parent / 'native/mdns_route.c', '-o', binary])
        assert json.loads(run([binary, '--check', 0, '172.20.10.0', 28])) == {
            'uid': 0, 'network': '172.20.10.0', 'prefix': 28}
        for arguments in [['--check', 65536, '172.20.10.0', 28], ['--check', -1, '172.20.10.0', 28],
                          ['--check', 0, '1.1.1.0', 24], ['--check', 0, '172.20.10.2', 28],
                          ['--check', 0, '10.0.0.0', 0], ['--check', 0, '172.20.0.0', 8],
                          ['add', 0, '172.20.10.0', 28, 254], ['flush']]:
            run([binary] + arguments, expected=64)
        if os.geteuid() != 0:
            run([binary, 'show'], expected=77)
        else:
            os.chmod(directory, 0o755)
            def unprivileged():
                os.setgroups([])
                os.setgid(65534)
                os.setuid(65534)
            result = subprocess.run([str(binary), 'show'], preexec_fn=unprivileged, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, timeout=10)
            assert result.returncode == 77, ('helper must reject a nonroot caller', result.returncode, result.stderr)
        if args.cli_only:
            print('Bonjour helper CLI validation and nonroot refusal passed (explicit CLI-only mode; no routing test)')
            return
        namespace_flag = '-n' if os.geteuid() == 0 else '-Urn'
        print(run(['unshare', namespace_flag, sys.executable, Path(__file__).resolve(),
                   '--inside', '--binary', binary]).strip())
        print('Bonjour helper CLI validation and real private-network-namespace checks passed')


if __name__ == '__main__':
    main()
