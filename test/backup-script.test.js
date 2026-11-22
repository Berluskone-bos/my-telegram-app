const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'backup', 'backup.sh');

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-script-test-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const executable = (name, body) => {
        const file = path.join(bin, name);
        fs.writeFileSync(file, body, { mode: 0o755 });
        fs.chmodSync(file, 0o755);
    };

    executable('pg_dump', `#!/bin/sh
if [ "${1:-}" = "--version" ]; then echo "pg_dump (PostgreSQL) 18"; exit 0; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) shift; OUT="$1" ;;
    --file=*) OUT="${1#--file=}" ;;
  esac
  shift
done
dd if=/dev/zero of="$OUT" bs=1024 count=4 2>/dev/null
[ "${FAKE_PG_DUMP_FAIL:-0}" = "1" ] && exit 42
exit 0
`);
    executable('openssl', `#!/bin/sh
INPUT=""
OUTPUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -in) shift; INPUT="$1" ;;
    -out) shift; OUTPUT="$1" ;;
  esac
  shift
done
if [ -n "$OUTPUT" ]; then cp "$INPUT" "$OUTPUT"; else cat "$INPUT"; fi
`);
    executable('pg_restore', `#!/bin/sh
[ "${1:-}" = "--list" ] || exit 2
echo "; TABLE DATA public sample postgres"
`);

    return { root, bin, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function runBackup(fixture, extraEnv = {}) {
    return spawnSync('/bin/sh', [script], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: fixture.bin + path.delimiter + process.env.PATH,
            DATABASE_URL: 'postgres://test.invalid/test',
            BACKUP_PASSPHRASE: 'test-only-passphrase',
            BACKUP_DIR: path.join(fixture.root, 'storage'),
            MIN_BYTES: '2000',
            ...extraEnv
        }
    });
}

test('backup stops and does not upload when pg_dump exits with an error', () => {
    const fixture = setup();
    try {
        const result = runBackup(fixture, { FAKE_PG_DUMP_FAIL: '1' });
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, /pg_dump|error|ошибка/i);
        assert.equal(fs.existsSync(path.join(fixture.root, 'storage', 'daily')), false);
    } finally {
        fixture.cleanup();
    }
});

test('backup encrypts, validates and stores a successful dump', () => {
    const fixture = setup();
    try {
        const result = runBackup(fixture);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /таблиц с данными: 1/);
        assert.match(result.stdout, /\[backup\] готово/);
        const files = fs.readdirSync(path.join(fixture.root, 'storage', 'daily'));
        assert.equal(files.length, 1);
        assert.match(files[0], /^gulf-.*\.dump\.enc$/);
    } finally {
        fixture.cleanup();
    }
});
