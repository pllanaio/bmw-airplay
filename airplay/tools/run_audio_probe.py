"""Private, bounded audio test on the owner's pinned MGU connection."""
from pathlib import Path
import argparse
import json
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from vehicle import connect

parser = argparse.ArgumentParser()
parser.add_argument('--pcm', action='store_true')
parser.add_argument('--tone', action='store_true')
parser.add_argument('--all-channels', action='store_true')
parser.add_argument('--physical', action='store_true', help='Route the verified decoded PCM source 386 to MainSink 1')
parser.add_argument('--speakers', action='store_true', help='Route the regular OAP source to MainSink 1')
parser.add_argument('--ram', action='store_true', help='Route decoded PCM 386 to the real RAM InputA_Main sink 129')
parser.add_argument('--decoder-ready', action='store_true', help='Announce decoded audio only during an exclusively owned OAP test route')
parser.add_argument('--meter', action='store_true', help='Observe only the test PCM source and its AVB output buffers')
parser.add_argument('--channel-tags', action='store_true', help='Tag input channels with distinct quiet amplitudes for mapping')
parser.add_argument('--test-volume', type=int, choices=range(1, 21), metavar='1..20', help='Temporarily set only the owned OAP connection volume, then restore it')
args = parser.parse_args()
if args.test_volume is not None and (not args.tone or args.physical or args.ram or args.speakers):
    parser.error('--test-volume requires --tone on the regular OAP route')
base = '/var/opt/pllana-airplay-probe-010'
remote = connect()
if args.pcm or args.tone:
    guard = ('const fs=require("fs"),p=' + json.dumps(base) + ';'
             'if(!fs.existsSync(p))fs.mkdirSync(p,448);'
             'const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0)throw Error("invalid probe directory");')
    subprocess.run(remote.command + ['exec /usr/bin/node -e ' + shlex.quote(guard)], check=True, timeout=12)
    with (ROOT / '.local/airplay/audio-probe-runtime.tar.gz').open('rb') as stream:
        subprocess.run(remote.command + ['exec /bin/tar -xz -f - -C ' + base], stdin=stream, check=True, timeout=20)
    expected = json.loads((ROOT / '.build/airplay/audio-probe/checksums.json').read_text())
    check = ('const fs=require("fs"),c=require("crypto"),base=' + json.dumps(base + '/runtime/') + ',expected=' + json.dumps(expected) + ';'
             'for(const n of Object.keys(expected))if(c.createHash("sha256").update(fs.readFileSync(base+n)).digest("hex")!==expected[n])throw Error("runtime hash mismatch");')
    subprocess.run(remote.command + ['exec /usr/bin/node -e ' + shlex.quote(check)], check=True, capture_output=True, timeout=12)
    # Retire only our previously copied distro ALSA file, never a system library.
    prune = ('const fs=require("fs"),c=require("crypto"),p=' + json.dumps(base + '/runtime/lib/libasound.so.2') + ';'
             'if(fs.existsSync(p)){if(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")!=="9dabddc79cc29b4f69058ac7d94ac11e82a4d6d8cc8c9148cb8377705790c7ea")throw Error("unexpected probe library");fs.unlinkSync(p);}')
    subprocess.run(remote.command + ['exec /usr/bin/node -e ' + shlex.quote(prune)], check=True, capture_output=True, timeout=12)
helper = (ROOT / 'airplay/tools/audio_probe.js').read_text()
probe = (ROOT / 'airplay/tools/route_audio_probe.js').read_text()
code = ('const localModule={exports:{}};new Function("require","module","exports",' + json.dumps(helper) + ')(require,localModule,localModule.exports);'
        'new Function("require",' + json.dumps(probe) + ')(name=>name==="./audio_probe"?localModule.exports:require(name));')
env = {}
if args.physical:
    env['MGU_PCM_PROBE_PHYSICAL'] = '1'
if args.speakers:
    env['MGU_PCM_PROBE_SPEAKERS'] = '1'
if args.ram:
    env['MGU_PCM_PROBE_RAM'] = '1'
if args.decoder_ready:
    env['MGU_PCM_PROBE_DECODER_READY'] = '1'
if args.meter:
    env['MGU_PCM_PROBE_METER'] = '1'
if args.channel_tags:
    env['MGU_PCM_PROBE_CHANNEL_TAGS'] = '1'
if args.test_volume is not None:
    env['MGU_PCM_PROBE_TEST_VOLUME'] = str(args.test_volume)
if args.pcm or args.tone:
    env.update({'MGU_PCM_PROBE_ROOT': base + '/runtime', 'MGU_PCM_PROBE_MODE': 'tone' if args.tone else 'query'})
    if args.all_channels:
        env['MGU_PCM_PROBE_ALL_CHANNELS'] = '1'
wrapper = ('const r=require("child_process").spawnSync("/usr/bin/node",["-e",' + json.dumps(code) + '],'
           '{encoding:"utf8",timeout:22000,maxBuffer:65536,env:Object.assign({},process.env,' + json.dumps(env) + ')});'
           'process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exitCode=r.status===null?2:r.status;')
result = subprocess.run(remote.command + ['exec /usr/bin/node -e ' + shlex.quote(wrapper)], capture_output=True, timeout=28)
name = 'audio-pcm-tone.log' if args.tone else 'audio-pcm-probe.log' if args.pcm else 'audio-route-probe.log'
if args.meter:
    name = 'meter-' + name
elif args.decoder_ready:
    name = 'decoder-ready-' + name
elif args.ram:
    name = 'ram-' + name
elif args.physical:
    name = 'physical-' + name
elif args.speakers:
    name = 'speakers-' + name
if args.test_volume is not None:
    name = 'volume-' + name
(ROOT / '.local/airplay' / name).write_bytes(result.stdout + result.stderr)
print(result.stdout.decode('utf8', 'replace'))
if result.stderr:
    print(result.stderr.decode('utf8', 'replace')[-1800:])
raise SystemExit(result.returncode)
