'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MapLinks = require('../bot/services/map-links');

const stops = [
    { lat: 59.93, lon: 30.33 },
    { lat: 59.94, lon: 30.34 },
    { lat: 59.95, lon: 30.35 }
];

test('маршруты навигаторов стартуют от текущего местоположения и сохраняют все точки доставки', () => {
    const links = MapLinks.allRoute(stops);
    assert.match(links.yandex, /rtext=~59\.93,30\.33~59\.94,30\.34~59\.95,30\.35/);
    assert.match(links.google, /destination=59\.95,30\.35/);
    assert.match(links.google, /waypoints=59\.93%2C30\.33%7C59\.94%2C30\.34/);
    assert.doesNotMatch(links.google, /origin=/);
    assert.match(links.gis2, /r=~30\.33,59\.93~30\.34,59\.94~30\.35,59\.95/);
});

test('одна точка доставки остаётся пунктом назначения, а не стартовой точкой', () => {
    const links = MapLinks.allRoute([stops[0]]);
    assert.match(links.yandex, /rtext=~59\.93,30\.33/);
    assert.match(links.google, /destination=59\.93,30\.33/);
    assert.doesNotMatch(links.google, /origin=|waypoints=/);
    assert.match(links.gis2, /r=~30\.33,59\.93/);
});
