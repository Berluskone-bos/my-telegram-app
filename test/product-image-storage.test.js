'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateImage, createPresignedUrl } = require('../bot/product-image-storage');

test('validates JPEG, PNG and WebP by content, not only filename or MIME', () => {
    assert.equal(validateImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg').ok, true);
    assert.equal(validateImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png').ok, true);
    assert.equal(validateImage(Buffer.from('RIFF0000WEBP'), 'image/webp').ok, true);
    assert.equal(validateImage(Buffer.from('not an image'), 'image/jpeg').ok, false);
    assert.equal(validateImage(Buffer.from('image'), 'text/plain').ok, false);
});

test('rejects empty and oversized images', () => {
    assert.equal(validateImage(Buffer.alloc(0), 'image/jpeg').ok, false);
    assert.equal(validateImage(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/jpeg').ok, false);
});

test('creates a short-lived HTTPS presigned URL for a product image', () => {
    const env = {
        PRODUCT_IMAGES_S3_ENDPOINT: 'https://t3.storageapi.dev',
        PRODUCT_IMAGES_S3_BUCKET: 'autopromoil-product-images-a7bws5',
        PRODUCT_IMAGES_S3_ACCESS_KEY_ID: 'test-access',
        PRODUCT_IMAGES_S3_SECRET_ACCESS_KEY: 'test-secret',
        PRODUCT_IMAGES_S3_REGION: 'auto'
    };
    const result = createPresignedUrl({
        operation: 'put',
        objectKey: 'products/123e4567-e89b-12d3-a456-426614174000.webp',
        contentType: 'image/webp',
        env,
        now: new Date('2026-11-26T12:00:00.000Z')
    });
    assert.equal(result.method, 'PUT');
    assert.match(result.url, /^https:\/\/autopromoil-product-images-a7bws5\.t3\.storageapi\.dev\//);
    assert.match(result.url, /X-Amz-Signature=[a-f0-9]{64}$/);
    assert.equal(result.headers['Content-Type'], 'image/webp');
});

test('rejects unconfigured storage and unsafe object keys', () => {
    assert.throws(() => createPresignedUrl({ operation: 'get', objectKey: 'products/../../secret.jpg', env: {} }), /Invalid product image key/);
    assert.throws(() => createPresignedUrl({ operation: 'get', objectKey: 'products/123e4567-e89b-12d3-a456-426614174000.jpg', env: {} }), { code: 'IMAGE_STORAGE_NOT_CONFIGURED' });
});
