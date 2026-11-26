'use strict';

const crypto = require('crypto');

const MIME_EXTENSIONS = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
});

function validateImage(buffer, contentType, maxBytes = 5 * 1024 * 1024) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maxBytes) {
        return { ok: false, error: 'Файл пустой или превышает 5 МБ' };
    }
    const extension = MIME_EXTENSIONS[String(contentType || '').toLowerCase()];
    if (!extension) return { ok: false, error: 'Поддерживаются только JPG, PNG и WebP' };

    const isJpeg = extension === 'jpg' && buffer.length >= 3 &&
        buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng = extension === 'png' && buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = extension === 'webp' && buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';

    if (!isJpeg && !isPng && !isWebp) return { ok: false, error: 'Содержимое файла не соответствует формату изображения' };
    return { ok: true, extension };
}

function awsEncode(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, char =>
        '%' + char.charCodeAt(0).toString(16).toUpperCase()
    );
}

function hmac(key, value, encoding) {
    return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function createPresignedUrl({ operation, objectKey, contentType, expiresIn = 600, env = process.env, now = new Date() }) {
    if (!['put', 'get'].includes(operation)) throw new Error('Unsupported storage operation');
    if (!/^products\/[a-f0-9-]+\.(jpg|png|webp)$/.test(String(objectKey || ''))) throw new Error('Invalid product image key');

    const endpoint = env.PRODUCT_IMAGES_S3_ENDPOINT;
    const bucket = env.PRODUCT_IMAGES_S3_BUCKET;
    const accessKey = env.PRODUCT_IMAGES_S3_ACCESS_KEY_ID;
    const secretKey = env.PRODUCT_IMAGES_S3_SECRET_ACCESS_KEY;
    const region = env.PRODUCT_IMAGES_S3_REGION || 'auto';
    if (!endpoint || !bucket || !accessKey || !secretKey) {
        const error = new Error('Product image storage is not configured');
        error.code = 'IMAGE_STORAGE_NOT_CONFIGURED';
        throw error;
    }

    const base = new URL(endpoint);
    if (base.protocol !== 'https:') throw new Error('Image storage endpoint must use HTTPS');
    const host = bucket + '.' + base.host;
    const encodedKey = objectKey.split('/').map(awsEncode).join('/');
    const canonicalUri = (base.pathname.replace(/\/$/, '') || '') + '/' + encodedKey;
    const nowIso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = nowIso.slice(0, 8);
    const credentialScope = dateStamp + '/' + region + '/s3/aws4_request';
    const params = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': accessKey + '/' + credentialScope,
        'X-Amz-Date': nowIso,
        'X-Amz-Expires': String(Math.max(1, Math.min(600, Number(expiresIn) || 600))),
        'X-Amz-SignedHeaders': 'host'
    };
    const canonicalQuery = Object.keys(params).sort().map(key => awsEncode(key) + '=' + awsEncode(params[key])).join('&');
    const method = operation === 'put' ? 'PUT' : 'GET';
    const canonicalRequest = [
        method,
        canonicalUri,
        canonicalQuery,
        'host:' + host + '\n',
        'host',
        'UNSIGNED-PAYLOAD'
    ].join('\n');
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        nowIso,
        credentialScope,
        crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    ].join('\n');
    const dateKey = hmac('AWS4' + secretKey, dateStamp);
    const regionKey = hmac(dateKey, region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = hmac(signingKey, stringToSign, 'hex');
    return {
        url: 'https://' + host + canonicalUri + '?' + canonicalQuery + '&X-Amz-Signature=' + signature,
        method,
        headers: operation === 'put' && contentType ? { 'Content-Type': contentType } : {}
    };
}

module.exports = { validateImage, createPresignedUrl };
