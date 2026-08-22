// Геокодер: адрес → координаты (Яндекс.Геокодер API)
// Бесплатно до 25 000 запросов в сутки

const https = require('https');

const GEOCODER_URL = 'https://geocode-maps.yandex.ru/1.x/';

class Geocoder {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    geocode(address) {
        return new Promise((resolve, reject) => {
            if (!this.apiKey) {
                reject(new Error('YANDEX_GEO_KEY не задан'));
                return;
            }

            const params = new URLSearchParams({
                apikey: this.apiKey,
                geocode: address,
                format: 'json',
                results: '1'
            });

            const url = `${GEOCODER_URL}?${params.toString()}`;

            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const members = json.response.GeoObjectCollection.featureMember;

                        if (!members || members.length === 0) {
                            resolve(null);
                            return;
                        }

                        const geo = members[0].GeoObject;
                        const [lon, lat] = geo.Point.pos.split(' ').map(Number);

                        resolve({
                            lat: lat,
                            lon: lon,
                            address: geo.metaDataProperty.GeocoderMetaData.text,
                            precision: geo.metaDataProperty.GeocoderMetaData.precision
                        });
                    } catch (e) {
                        reject(new Error('Ошибка парсинга ответа геокодера: ' + e.message));
                    }
                });
            }).on('error', reject);
        });
    }
}

module.exports = Geocoder;
