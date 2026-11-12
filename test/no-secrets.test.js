'use strict';
// Охранный тест: в репозиторий не должны попадать токены ботов, пароли БД и файлы с логами/секретами.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const textFiles = files.filter(f => !/\.(png|jpe?g|gif|webp|xlsx|pdf|zip|pyc|ico)$/i.test(f) && fs.existsSync(path.join(root, f)));

test('в отслеживаемых файлах нет токенов Telegram-ботов', () => {
    const re = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/;
    const bad = textFiles.filter(f => re.test(fs.readFileSync(path.join(root, f), 'utf8')));
    assert.deepEqual(bad, [], 'токен найден в: ' + bad.join(', '));
});

test('в файлах нет адресов БД с настоящим паролем (допустимы user:pass и подобные заглушки)', () => {
    const re = /postgres(?:ql)?:\/\/([^:@\s/]+):([^@\s]+)@/g;
    const placeholder = /^(user|pass|password|пароль|логин|<.*>|\*+|\$\{.*\}|xxx+|your.*|\.\.\.|…)$/i;
    const bad = [];
    for (const f of textFiles) {
        const t = fs.readFileSync(path.join(root, f), 'utf8');
        for (const m of t.matchAll(re)) if (!placeholder.test(m[1]) || !placeholder.test(m[2])) bad.push(f);
    }
    assert.deepEqual([...new Set(bad)], []);
});

test('в репозитории нет .env, логов и кэша Python', () => {
    const bad = files.filter(f => /(^|\/)\.env$/.test(f) || /(^|\/)(bot-)?logs?\.txt$/i.test(f) || /\.log$/i.test(f) || /__pycache__|\.pyc$/.test(f));
    assert.deepEqual(bad, []);
});
