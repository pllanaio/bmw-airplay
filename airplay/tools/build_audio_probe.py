"""Make a small private PCM diagnostic runtime from signed distro packages."""
from pathlib import Path
import json
import re
import shutil
import subprocess
import tarfile
import hashlib

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.build/airplay/audio-probe'
for directory in ['bin', 'lib', 'plugins']:
    (OUT / directory).mkdir(parents=True, exist_ok=True)
subprocess.run(['gcc', '-O2', '-Wall', '-Wextra', '-Werror',
                str(ROOT / 'airplay/native/alsa_probe.c'), '-ldl', '-o', str(OUT / 'bin/alsa-probe')], check=True)
shutil.copy2('/usr/bin/gst-launch-1.0', OUT / 'bin/gst-launch-1.0')
for name in ['alsa', 'audiotestsrc', 'audioconvert', 'audioresample', 'coreelements']:
    shutil.copy2('/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgst' + name + '.so', OUT / 'plugins')
roots = list((OUT / 'bin').iterdir()) + list((OUT / 'plugins').iterdir())
libs = {name: Path('/usr/lib/x86_64-linux-gnu') / name for name in
        ['libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libutil.so.1',
         'libresolv.so.2', 'libstdc++.so.6', 'libgcc_s.so.1']}
for p in roots:
    text = subprocess.check_output(['ldd', str(p)], text=True)
    if 'not found' in text:
        raise RuntimeError(text)
    for value in re.findall(r'(?:=>\s*)?(/[^\s()]+)', text):
        lib = Path(value)
        if lib.is_file():
            libs[lib.name] = lib
for name, lib in libs.items():
    if name == 'libasound.so.2':
        continue  # MGU SmartX uses an OEM-patched ALSA ioplug ABI.
    shutil.copy2(lib, OUT / 'lib' / name)
(OUT / 'lib/libasound.so.2').unlink(missing_ok=True)
records = {p.relative_to(OUT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
           for p in OUT.rglob('*') if p.is_file() and p.name != 'checksums.json'}
(OUT / 'checksums.json').write_text(json.dumps(records))
archive = ROOT / '.local/airplay/audio-probe-runtime.tar.gz'
with tarfile.open(archive, 'w:gz') as tf:
    tf.add(OUT, arcname='runtime')
print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'files': len(records)}))
