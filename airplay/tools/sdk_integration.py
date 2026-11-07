"""The same private kit patches for workstation and MGU Store builds."""
from pathlib import Path
import hashlib
import json
import shutil
from bake_ui_fonts import bake
from patch_sdk import patch_display


ROOT = Path(__file__).resolve().parents[2]


def configure_kit(kit, prebaked_fonts=False):
    kit = Path(kit)
    output = kit / 'runtime/fonts'
    if prebaked_fonts:
        fonts = ROOT / 'assets/fonts'
        manifest = json.loads((fonts / 'atlas-manifest.json').read_text())
        atlas = (fonts / 'airplay.json').read_bytes()
        if hashlib.sha256(atlas).hexdigest() != manifest['atlas_sha256']:
            raise RuntimeError('Prebaked font atlas checksum differs')
        data = json.loads(atlas)
        output.mkdir(parents=True, exist_ok=True)
        (output / 'airplay.json').write_bytes(atlas)
        data['family'] = 'label'
        (output / 'label.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf8')
        for name in ['LICENCE.txt', 'COPYRIGHT.txt']:
            shutil.copy2(fonts / name, output / ('Ubuntu-' + name))
    else:
        bake(kit.parent, output)
    render = kit / 'runtime/renderd.js'
    text = render.read_text()
    old = 'frontGate: !!(caps & 4)'
    if text.count(old) != 1:
        raise RuntimeError('unexpected SDK video capabilities parser')
    text = text.replace(old, old + ', video: !!(caps & 16)')
    old = "['/run/mgu-renderd/renderd.sock', '/run/mgu-render/render.sock']"
    if text.count(old) != 1:
        raise RuntimeError('unexpected SDK renderer socket preference')
    text = text.replace(old, "['/run/mgu-render/render.sock', '/run/mgu-renderd/renderd.sock']")
    render.write_text(text)
    display = kit / 'runtime/display.js'
    display.write_text(patch_display(display.read_text()))
    return render, display
