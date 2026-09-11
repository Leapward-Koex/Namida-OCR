import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('release_archives',
    Path(__file__).resolve().parents[1] / 'scripts' / 'verify-release-archives.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseArchiveTests(unittest.TestCase):
    def write_archives(self, directory, *, commit='a' * 40, version='2.0.42', dirty=False,
                       attempt=1, variant_override=None, nested=False, wrapped=False):
        for asset, browser, variant in [('chromium', 'chrome', 'server'),
                                         ('firefox', 'firefox', 'mobile_det_server_rec')]:
            info = dict(version=version, versionName=f'Build 42.{attempt}', commit=commit, dirty=dirty,
                        browser=browser, paddleOcrModelVariant=variant_override or variant,
                        sequence=42, attempt=attempt, runId='77')
            content = {
                'manifest.json': json.dumps(dict(version=version, version_name=info['versionName'])),
                'build-info.json': json.dumps(info),
                'libs/paddleocr/paddleocr-manifest.json': json.dumps(dict(variant=variant_override or variant)),
                'ui/index.js': 'fixture', 'ui/popup.html': 'fixture', 'paddle-worker/index.js': 'fixture',
                'libs/paddleocr/detection/v6/det.onnx': 'fixture',
                'libs/paddleocr/languages/chinese/rec.onnx': 'fixture',
            }
            if nested:
                content['libs/manifest.json'] = '{}'
            with zipfile.ZipFile(Path(directory) / f'namida-ocr-{asset}-2.0.42.zip', 'w') as archive:
                for name, body in content.items():
                    archive.writestr(('dist/' if wrapped else '') + name, body)

    def test_accepts_same_run_and_version_across_rerun_attempts(self):
        with tempfile.TemporaryDirectory() as directory:
            self.write_archives(directory, attempt=1)
            chromium = Path(directory) / 'namida-ocr-chromium-2.0.42.zip'
            earlier_artifact = chromium.read_bytes()
            self.write_archives(directory, attempt=2)
            chromium.write_bytes(earlier_artifact)
            self.assertEqual(len(release.verify_archives(directory, '2.0.42', 'a' * 40, '77')), 2)

    def test_rejects_wrong_identity_browser_bundle_and_archive_layout(self):
        for override in [dict(commit='b' * 40), dict(version='2.0.43'), dict(dirty=True),
                         dict(variant_override='mobile'), dict(nested=True), dict(wrapped=True)]:
            with self.subTest(override=override), tempfile.TemporaryDirectory() as directory:
                self.write_archives(directory, **override)
                with self.assertRaises(ValueError):
                    release.verify_archives(directory, '2.0.42', 'a' * 40, '77')

    def test_rejects_unexpected_assets_and_other_workflow_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            self.write_archives(directory)
            with self.assertRaises(ValueError):
                release.verify_archives(directory, '2.0.42', 'a' * 40, '78')
            (Path(directory) / 'unexpected.zip').write_bytes(b'')
            with self.assertRaises(ValueError):
                release.verify_archives(directory, '2.0.42', 'a' * 40, '77')


if __name__ == '__main__':
    unittest.main()
