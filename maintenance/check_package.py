"""Read-only checks for the locally prepared GitHub publication."""
import json
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.refs, self.ids = [], set()
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.add(attrs['id'])
        for field in ('href', 'src', 'poster'):
            if field in attrs:
                self.refs.append(attrs[field])


def main():
    errors, checked = [], 0
    pages = {p: Page(p.read_text(encoding='utf-8')) for p in [ROOT / 'index.html', *ROOT.joinpath('docs').glob('*.html')]}
    for path, page in pages.items():
        for ref in page.refs:
            uri = urlsplit(ref)
            if uri.scheme or uri.netloc:
                continue
            target = (path.parent / unquote(uri.path)).resolve() if uri.path else path
            if not target.is_relative_to(ROOT) or not target.exists():
                errors.append(f'{path.name}: missing or out-of-package {ref}')
            elif uri.fragment and target in pages and unquote(uri.fragment) not in pages[target].ids:
                errors.append(f'{path.name}: missing anchor {ref}')
            checked += 1
    for path in ROOT.rglob('*.json'):
        json.loads(path.read_text(encoding='utf-8-sig'))
    for path in ROOT.rglob('*'):
        if path.is_file() and path.stat().st_size >= 100 * 1024 * 1024:
            errors.append(f'File exceeds 100 MiB: {path.relative_to(ROOT)}')
    archive_path = ROOT / 'ccx/com.local.photoshop.flux-local-edit_PS.ccx'
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.testzip() is None
        manifest = json.loads((ROOT / 'plugin/manifest.json').read_text(encoding='utf-8-sig'))
        if json.loads(archive.read('manifest.json')) != manifest:
            errors.append('CCX manifest differs from publication source')
        assert manifest['id'] == 'com.local.photoshop.flux-local-edit'
        assert manifest['version'] == '0.2.2'
        for path in (ROOT / 'plugin').rglob('*'):
            if not path.is_file() or 'tests' in path.parts or path.name == 'manifest.json':
                continue
            relative = path.relative_to(ROOT / 'plugin').as_posix()
            if path.read_bytes() != archive.read(relative):
                errors.append(f'CCX runtime differs: {relative}')
    if errors:
        raise SystemExit('\n'.join(errors))
    print(f'PASS: {checked} local HTML references, JSON, CCX archive, manifest and runtime integrity, file sizes')


if __name__ == '__main__':
    main()
