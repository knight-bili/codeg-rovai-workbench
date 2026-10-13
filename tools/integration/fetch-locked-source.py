"""从固定公开Git提交提取CI供体；只写本次runner临时目录。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.request
import zipfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('source_id')
parser.add_argument('destination', type=Path)
parser.add_argument('--archive', type=Path, help='仅用于离线提取规则测试')
args = parser.parse_args()
sources = json.loads((root / 'integration/sources.lock.json').read_text(encoding='utf-8'))['sources']
source = next(item for item in sources if item['id'] == args.source_id)
assert re.fullmatch(r'[0-9a-f]{40}', source['commit'])
assert re.fullmatch(r'https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', source['repository'])
runner_temp = Path(os.environ['RUNNER_TEMP']).resolve()
destination = args.destination.resolve()
assert destination != runner_temp and destination.is_relative_to(runner_temp), 'destination_outside_runner_temp'
assert not destination.exists(), 'destination_already_exists'
repository = source['repository'].removeprefix('https://github.com/')
prefix = f"{repository.split('/')[1]}-{source['commit']}/"
with tempfile.TemporaryDirectory(prefix='locked-source-', dir=runner_temp) as scratch:
    archive_path = Path(scratch) / 'source.zip'
    if args.archive:
        shutil.copyfile(args.archive, archive_path)
    else:
        urllib.request.urlretrieve(f"https://codeload.github.com/{repository}/zip/{source['commit']}", archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.infolist()
        assert members, 'empty_source_archive'
        for item in members:
            assert item.filename.startswith(prefix), 'unexpected_archive_prefix'
            relative = item.filename[len(prefix):]
            assert '\\' not in relative, 'noncanonical_archive_path'
            target = (destination / relative).resolve()
            assert target.is_relative_to(destination), 'archive_path_escape'
            assert (item.external_attr >> 16) & 0o170000 != 0o120000, 'archive_symlink_not_admitted'
        destination.mkdir()
        for item in members:
            relative = item.filename[len(prefix):]
            if not relative:
                continue
            target = destination / relative
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as content, target.open('xb') as output:
                    shutil.copyfileobj(content, output)
                if item.external_attr >> 16 & 0o111:
                    target.chmod(0o755)
    metadata = {'sourceId': source['id'], 'repository': source['repository'], 'commit': source['commit'],
                'archiveSha256': hashlib.sha256(archive_path.read_bytes()).hexdigest()}
    (destination / 'foundation-source.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
print(json.dumps(metadata))
