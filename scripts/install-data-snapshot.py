"""Read-only installation evidence; compressed backup excludes audio and build caches."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import zipfile

def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()

def protected(root):
    files = []
    for name in ('runtime.json', 'speaker-runtime.json'):
        path = root / name
        if path.is_file():
            files.append(path)
    for name in ('recordings', 'workspaces', 'vaults'):
        directory = root / name
        if not directory.is_dir():
            continue
        for current, directories, names in os.walk(directory, followlinks=False):
            directories[:] = [name for name in directories if name not in ('job-metadata', 'speaker-metadata') and not (Path(current) / name).is_symlink()]
            for name in names:
                path = Path(current) / name
                if path.is_file() and not path.is_symlink() and path.suffix not in ('.lock', '.part', '.tmp'):
                    files.append(path)
    return sorted(files)

def database(root):
    path = root / 'meeting_minutes.sqlite'
    records = {}
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for name in ('meetings', 'transcripts', 'meeting_notes', 'summaries'):
            if name not in tables:
                continue
            rows = connection.execute('SELECT * FROM "' + name + '"').fetchall()
            encoded = sorted(json.dumps(row, ensure_ascii=False, default=lambda value: value.hex() if isinstance(value, bytes) else str(value)) for row in rows)
            records[name] = {'count': len(rows), 'sha256': hashlib.sha256('\n'.join(encoded).encode()).hexdigest()}
    return records

def snapshot(root):
    files = protected(root)
    return {'data_root': str(root), 'files': {str(path.relative_to(root)): {'size': path.stat().st_size, 'sha256': digest(path)} for path in files}, 'database': database(root)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('before', 'after'))
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=True)
    data = snapshot(root)
    output = args.output / (args.mode + '.json')
    if output.exists():
        raise RuntimeError('Refusing to replace an existing installation snapshot')
    output.write_text(json.dumps(data, indent=2), encoding='utf8')
    if args.mode == 'before':
        backup = args.output / 'notes-backup.zip'
        with zipfile.ZipFile(backup, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
            for relative in data['files']:
                path = root / relative
                if path.suffix.lower() in ('.json', '.md', '.txt'):
                    archive.write(path, relative)
            archive.write(root / 'meeting_minutes.sqlite', 'meeting_minutes.sqlite')
        print(json.dumps({'protected_files': len(data['files']), 'protected_bytes': sum(item['size'] for item in data['files'].values()), 'backup_bytes': backup.stat().st_size, 'database_counts': {name: item['count'] for name, item in data['database'].items()}}))
    else:
        before = json.loads((args.output / 'before.json').read_text(encoding='utf8'))
        changed = [name for name, value in before['files'].items() if data['files'].get(name) != value]
        missing = [name for name in before['files'] if name not in data['files']]
        added = [name for name in data['files'] if name not in before['files']]
        db_same = before['database'] == data['database']
        result = {'protected_files': len(data['files']), 'changed_count': len(changed), 'missing_count': len(missing), 'added_count': len(added), 'database_unchanged': db_same}
        print(json.dumps(result))
        if changed or missing or not db_same:
            raise RuntimeError('Installation data verification failed; preserve both snapshots and backup')

if __name__ == '__main__':
    main()
