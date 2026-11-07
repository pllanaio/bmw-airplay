"""Package the generated logo for the OAP icon and native RGBA renderer."""
from pathlib import Path
from PIL import Image
import base64
import zlib
ROOT = Path(__file__).resolve().parents[2]
app = ROOT / 'apps/pllana_airplay'
image = Image.open(ROOT / 'airplay/branding/pllana-airplay-logo.png').convert('RGBA')
image.resize((140, 140), Image.Resampling.LANCZOS).save(app / 'icon.png')
raw = image.resize((128, 128), Image.Resampling.LANCZOS).tobytes()
encoded = base64.b64encode(zlib.compress(raw, 9)).decode()
(app / 'brand_logo.js').write_text("'use strict';\n// Generated from airplay/branding/pllana-airplay-logo.png.\n"
    "const ID = 0x4c500001;\nconst pixels = require('zlib').inflateSync(Buffer.from('" + encoded + "', 'base64'));\n"
    "module.exports = { ID, pixels, register(setImage) { setImage(ID, 128, 128, pixels); } };\n", encoding='utf8')
