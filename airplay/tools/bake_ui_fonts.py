"""Owner SDK font baker, copied atlas with German glyphs; originals untouched."""
from pathlib import Path
import importlib.util
import json
import os
import shutil

ROOT = Path(__file__).resolve().parents[2]

def bake(sdk, output):
    spec = importlib.util.spec_from_file_location('airplay_font_baker', sdk / 'kit/tools/bake_fonts.py')
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    output.mkdir(parents=True, exist_ok=True)
    # Distinct family IDs prevent collisions with other apps' shared atlases.
    baker.FONTDIR = str(ROOT / 'assets/fonts')
    chars = baker.TEXT + 'äöüÄÖÜß„“'
    family = 'airplay'
    data = {'family': family, 'cacheKey': 'de-1', 'source': 'Ubuntu-Regular.ttf',
            'sizes': [baker.bake('Ubuntu-Regular.ttf', None, size, chars)
                      for size in [18, 24, 32, 44, 64]]}
    (output / (family + '.json')).write_text(json.dumps(data, separators=(',', ':')), encoding='utf8')
    data['family'] = 'label'
    (output / 'label.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf8')
    for name in ['LICENCE.txt', 'COPYRIGHT.txt']:
        shutil.copy2(ROOT / 'assets/fonts' / name, output / ('Ubuntu-' + name))

if __name__ == '__main__':
    settings_file = ROOT / '.local/development.json'
    settings = json.loads(settings_file.read_text()) if settings_file.exists() else {}
    sdk = os.environ.get('MGU_SDK_PATH') or settings.get('sdkPath')
    if not sdk:
        raise SystemExit('Set MGU_SDK_PATH or .local/development.json sdkPath')
    if os.name == 'posix' and sdk[1:3] == ':/':
        sdk = '/mnt/' + sdk[0].lower() + sdk[2:]
    bake(Path(sdk), ROOT / '.build/airplay/ui-fonts')
