"""Standard-library checks; no donor SDK or vehicle is needed."""
from pathlib import Path
import hashlib
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('airplay_store_build', ROOT / 'tools/build_store.py')
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class StoreInputTests(unittest.TestCase):
    def test_wrong_archive_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fake = root / 'fake.tar.gz'
            fake.write_bytes(b'not the pinned kit')
            with patch.dict(os.environ, {'MGU_KIT_ARCHIVE': str(fake)}):
                with self.assertRaisesRegex(RuntimeError, 'checksum differs'):
                    store.kit_archive(root / 'download.tar.gz')

    def bad_member(self, name, symlink=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / 'kit.tar.gz'
            with tarfile.open(archive, 'w:gz') as package:
                item = tarfile.TarInfo('idrive7-apps-' + store.KIT_COMMIT + '/' + name)
                if symlink:
                    item.type = tarfile.SYMTYPE
                    item.linkname = '/etc/passwd'
                    package.addfile(item)
                else:
                    item.size = 1
                    package.addfile(item, io.BytesIO(b'x'))
            with self.assertRaises(RuntimeError):
                store.extract_kit(archive, root / 'out')
            self.assertFalse((root / 'escape').exists())

    def test_parent_traversal_is_rejected(self):
        self.bad_member('kit/../../escape')

    def test_symlink_is_rejected(self):
        self.bad_member('kit/unsafe', symlink=True)

    def test_backslash_path_is_rejected(self):
        self.bad_member('kit/a\\b')

    def test_font_asset_provenance_and_german_glyphs(self):
        folder = ROOT / 'assets/fonts'
        record = json.loads((folder / 'atlas-manifest.json').read_text())
        atlas = (folder / 'airplay.json').read_bytes()
        self.assertEqual(hashlib.sha256(atlas).hexdigest(), record['atlas_sha256'])
        self.assertEqual(hashlib.sha256((folder / record['font']).read_bytes()).hexdigest(), record['font_sha256'])
        for size in json.loads(atlas)['sizes']:
            for ch in 'äöüÄÖÜß„“…':
                self.assertIn(str(ord(ch)), size['glyphs'])

    def test_published_app_and_native_sources_unchanged(self):
        snapshot = json.loads((ROOT / 'SNAPSHOT.json').read_text())
        for name, digest in snapshot['source_files'].items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest, name)


if __name__ == '__main__':
    unittest.main()
