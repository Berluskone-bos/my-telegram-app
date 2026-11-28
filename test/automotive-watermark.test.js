const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const carAssetPath = path.join(root, 'img', 'car-watermark.webp');

test('Mini App uses a light automotive watermark instead of the notebook grid', () => {
    assert.match(styles, /background-image:\s*none;/);
    assert.match(styles, /body::before\s*\{[^}]*car-watermark\.webp/s);
    assert.match(styles, /opacity:\s*0\.055/);
    assert.match(index, /css\/styles\.css\?v=20261128-light-car-watermark/);
});

test('Admin dashboard uses the same subtle watermark without removing theme support', () => {
    assert.match(admin, /body::before\s*\{[^}]*car-watermark\.webp/s);
    assert.match(admin, /body::before\s*\{[^}]*opacity:\s*\.04;/s);
    assert.match(admin, /:root\[data-theme="dark"\]\s+body::before\s*\{\s*opacity:\s*\.025;\s*\}/);
    assert.match(admin, /:root\[data-theme="dark"\]\s+body::before\s*\{\s*opacity:\s*\.02;\s*\}/);
    assert.match(admin, /:root\[data-theme="dark"\]/);
});

test('Decorative automotive background cannot intercept interface interactions', () => {
    assert.match(styles, /body::before\s*\{[^}]*pointer-events:\s*none;/s);
    assert.match(admin, /body::before\s*\{[^}]*pointer-events:\s*none;/s);
});

test('Automotive watermark is shipped as a valid lightweight WebP asset', () => {
    assert.equal(fs.existsSync(carAssetPath), true);
    const asset = fs.readFileSync(carAssetPath);
    assert.equal(asset.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(asset.subarray(8, 12).toString('ascii'), 'WEBP');
});
