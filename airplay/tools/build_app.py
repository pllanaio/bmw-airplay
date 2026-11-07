"""Build the private AirPlay app using the owner's SDK; no vehicle connection."""
from pathlib import Path
import importlib.util
import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
from sdk_integration import configure_kit

ROOT = Path(__file__).resolve().parents[2]
settings_file = ROOT / '.local/development.json'
settings = json.loads(settings_file.read_text()) if settings_file.exists() else {}
sdk_path = os.environ.get('MGU_SDK_PATH') or settings.get('sdkPath')
if not sdk_path:
    raise SystemExit('Set MGU_SDK_PATH or .local/development.json sdkPath')
if os.name == 'posix' and sdk_path[1:3] == ':/':
    sdk_path = '/mnt/' + sdk_path[0].lower() + sdk_path[2:]
SDK = Path(sdk_path)
sys.path.insert(0, str(SDK / 'kit/tools'))
spec = importlib.util.spec_from_file_location('airplay_sdk_build', SDK / 'kit/tools/build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
(ROOT / '.build/airplay').mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='app-', dir=ROOT / '.build/airplay'))
kit = work / 'kit'
shutil.copytree(SDK / 'kit', kit)
render, display = configure_kit(kit)
build.KIT, build.SDK = str(kit), str(SDK / 'oap-sdk')
build.APPS, build.DIST = str(ROOT / 'apps'), str(ROOT / 'dist')
build.build('pllana_airplay')
stage = ROOT / 'dist/pllana_airplay'
runtime = ROOT / '.build/airplay/runtime'
if not (runtime / 'plugins/libgstautodetect.so').is_file():
    raise RuntimeError('Rebuild runtime including UxPlay required autodetect plugin')
# Runtime is installed as a separate versioned tool. Keep the package handled
# by BMW MainApp small; loading a 100 MB OAP archive would burden its heap.
version = json.loads((ROOT / 'apps/pllana_airplay/app.json').read_text())['version']


def modes(info):
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.mode = 0o755 if info.isdir() or '/runtime/bin/' in info.name or info.name.endswith('/ld-linux-x86-64.so.2') else 0o644
    return info


bundle = ROOT / ('dist/pllana_airplay@' + version + '.mgu')
with tarfile.open(bundle, 'w:gz', compresslevel=1) as archive:
    for name in ['meta.json', 'source', 'rhmiData', 'oapgen']:
        archive.add(stage / name, arcname=name, filter=modes)
npm = ROOT / ('dist/pllana_airplay@' + version + '.tgz')
with tarfile.open(npm, 'w:gz', compresslevel=1) as archive:
    archive.add(stage / 'source', arcname='package', filter=modes)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
record = {
    'id': 'pllana_airplay', 'version': version, 'hardware_qualified': False,
    'pcm_root_test_verified': True, 'drm_supported': False,
    'app_sha256': sha(bundle), 'runtime_manifest_sha256': sha(runtime / 'build-manifest.json'),
    'sources': {p.name: sha(p) for p in (ROOT / 'apps/pllana_airplay').glob('*') if p.is_file()},
    'sdk_index_sha256': sha(SDK / 'oap-sdk/index.js'),
    'sdk_render_patch_sha256': sha(render),
    'sdk_display_patch_sha256': sha(display),
    'german_font_sha256': sha(kit / 'runtime/fonts/airplay.json'),
}
(ROOT / 'dist/airplay-build-provenance.json').write_text(json.dumps(record, indent=2))
print(json.dumps({'app': str(bundle), 'bytes': bundle.stat().st_size, 'sha256': record['app_sha256']}))
