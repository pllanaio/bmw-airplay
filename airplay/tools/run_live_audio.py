"""Run the read-only audio observer over the existing pinned SSH connection."""
from pathlib import Path
import json
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from vehicle import connect

helper = (ROOT / 'airplay/tools/audio_probe.js').read_text()
details = '--details' in sys.argv[1:]
observer = (ROOT / ('airplay/tools/audio_route_details.js' if details else 'airplay/tools/live_audio.js')).read_text()
code = ('const localModule={exports:{}};new Function("require","module","exports",' + json.dumps(helper) + ')(require,localModule,localModule.exports);'
        'new Function("require",' + json.dumps(observer) + ')(name=>name==="./audio_probe"?localModule.exports:require(name));')
wrapper = ('const r=require("child_process").spawnSync("/usr/bin/node",["-e",' + json.dumps(code) + '],'
           '{encoding:"utf8",timeout:26000,maxBuffer:262144});'
           'process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exitCode=r.status===null?2:r.status;')
result = subprocess.run(connect().command + ['exec /usr/bin/node -e ' + shlex.quote(wrapper)], capture_output=True, timeout=32)
output = ROOT / ('.local/airplay/audio-route-details.log' if details else '.local/airplay/live-audio.log')
output.write_bytes(result.stdout + result.stderr)
for line in result.stdout.decode('utf8', 'replace').splitlines():
    item = json.loads(line)
    if 'sources' in item:
        print(json.dumps({'source_count': len(item['sources'].get('listMainSources', [])), 'sinks': item['sinks']}))
    elif 'config_paths' in item:
        print(json.dumps({'config_paths': [p for p in item['config_paths'] if p['path'] != '/run/smartx']}))
    else:
        print(line)
if result.stderr:
    print(result.stderr.decode('utf8', 'replace')[-1600:])
raise SystemExit(result.returncode)
