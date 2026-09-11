"""Verify the exact browser archives before attaching them to a GitHub release."""
import json
import os
from pathlib import Path
import sys
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_archives(directory, version, commit, run_id=None):
    directory = Path(directory)
    targets = {f"namida-ocr-{asset}-{version}.zip": (browser, variant) for asset, browser, variant in [
        ("chromium", "chrome", "server"), ("firefox", "firefox", "mobile_det_server_rec")
    ]}
    require({item.name for item in directory.iterdir()} == set(targets), "Expected exactly the two browser ZIPs")
    for filename, (browser, variant) in targets.items():
        with zipfile.ZipFile(directory / filename) as archive:
            names = archive.namelist()
            require(len(names) == len(set(names)), f"Duplicate ZIP entries: {filename}")
            require([name for name in names if name.split('/')[-1] == 'manifest.json'] == ['manifest.json'],
                    f"Root manifest missing or nested manifest present: {filename}")
            manifest = json.loads(archive.read('manifest.json'))
            info = json.loads(archive.read('build-info.json'))
            paddle = json.loads(archive.read('libs/paddleocr/paddleocr-manifest.json'))
            require(info['version'] == manifest['version'] == version, f"Wrong version: {filename}")
            require(info['commit'] == commit and info['dirty'] is False, f"Wrong or modified source: {filename}")
            require(manifest['version_name'] == info['versionName'], f"Wrong version label: {filename}")
            require(info['browser'] == browser, f"Wrong browser: {filename}")
            require(info['paddleOcrModelVariant'] == paddle['variant'] == variant, f"Wrong model bundle: {filename}")
            require(info['sequence'] is not None, f"Local build cannot be released: {filename}")
            if run_id is not None:
                require(info['runId'] == run_id, f"Artifact from a different workflow run: {filename}")
            for required in ['ui/index.js', 'ui/popup.html', 'paddle-worker/index.js',
                             'libs/paddleocr/detection/v6/det.onnx', 'libs/paddleocr/languages/chinese/rec.onnx']:
                require(archive.getinfo(required).file_size > 0, f"Empty required asset: {required}")
            require(archive.testzip() is None, f"Corrupt archive: {filename}")
    return list(targets)


if __name__ == '__main__':
    files = verify_archives(sys.argv[1], sys.argv[2], sys.argv[3], os.environ.get('GITHUB_RUN_ID'))
    print('Verified release archives: ' + ', '.join(files))
