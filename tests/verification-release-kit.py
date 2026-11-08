"""Read-only verification of the served release archive and public contracts."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import urllib.request
import zipfile

origin = os.environ.get('NABDA_PREVIEW_URL', 'http://127.0.0.1:5174').rstrip('/')
def get(route):
    request = urllib.request.Request(origin + route, headers={'User-Agent': 'Nabda-Free-Release-QA/0.2.0'})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200
        return response.read()

archive = get('/downloads/Nabda-Free-Starter-0.2.0.zip')
sha = hashlib.sha256(archive).hexdigest()
assert get('/downloads/Nabda-Free-Starter-0.2.0.zip.sha256').decode().split()[0] == sha
expected = {'README.md', 'SHA256SUMS.txt', 'api-kit/Nabda.postman_collection.json', 'api-kit/Nabda.postman_environment.json', 'api-kit/nabda.mjs', 'api-kit/nabda.py', 'downloads/Nabda-Android-0.2.0.apk', 'downloads/THIRD-PARTY-NOTICES.txt', 'openapi.json'}
with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
    assert set(bundle.namelist()) == expected and len(bundle.namelist()) == 9
    assert bundle.testzip() is None
    checksums = {}
    for line in bundle.read('SHA256SUMS.txt').decode().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        match = re.fullmatch(r'([a-f0-9]{64})\s+(.+)', line)
        assert match, line
        checksums[match[2]] = match[1]
    assert set(checksums) == expected - {'SHA256SUMS.txt'}
    for name, expected_sha in checksums.items():
        value = bundle.read(name)
        assert hashlib.sha256(value).hexdigest() == expected_sha, name
        route = '/api-kit/README.md' if name == 'README.md' else '/' + name
        assert value == get(route), f'Archive/public file differs: {name}'
    with zipfile.ZipFile(io.BytesIO(bundle.read('downloads/Nabda-Android-0.2.0.apk'))) as apk:
        assert apk.read('assets/third-party-notices.txt') == bundle.read('downloads/THIRD-PARTY-NOTICES.txt')
    readme = bundle.read('README.md').decode()
    for text in ['without SMS/phone permission', 'raw API itself defaults', 'sandbox', 'integration kit', 'not a self-hosted', 'does not automatically retry']:
        assert text in readme, text
    environment = json.loads(bundle.read('api-kit/Nabda.postman_environment.json'))
    assert all(item['value'] == '' for item in environment['values'])
    assert next(item for item in environment['values'] if item['key'] == 'api_key')['type'] == 'secret'
    collection = json.loads(bundle.read('api-kit/Nabda.postman_collection.json'))
    assert 'sandbox:true' in json.dumps(collection)
    assert not any('live' in item['name'].lower() for item in collection['item'])
    spec = json.loads(bundle.read('openapi.json'))
    operations = sum(key.lower() in {'get', 'post', 'put', 'patch', 'delete', 'head', 'options'} for route in spec['paths'].values() for key in route)
    assert operations == 17
    schemas = spec['components']['schemas']
    assert schemas['MessageCreate']['properties']['sandbox']['default'] is False
    for name in ['parts_total', 'parts_sent', 'parts_delivered']:
        assert 'null' in schemas['Message']['properties'][name]['type']
    assert 'sandbox: !opts["--live"]' in bundle.read('api-kit/nabda.mjs').decode()
    assert '"sandbox": not args.live' in bundle.read('api-kit/nabda.py').decode()
report = {'origin': origin, 'archive_bytes': len(archive), 'sha256': sha, 'files': sorted(expected), 'internal_checksums': 8, 'public_files_match_archive': True, 'openapi_operations': operations, 'raw_sandbox_default': False, 'starter_sandbox_default': True, 'blank_postman_environment': True, 'no_sms_or_api_writes': True}
output = Path('outputs/qa/free-release')
output.mkdir(parents=True, exist_ok=True)
(output / 'kit-verify-results.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
