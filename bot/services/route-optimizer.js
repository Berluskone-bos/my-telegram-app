// Оптимизатор маршрутов: алгоритм ближайшего соседа
// Сортирует адреса так, чтобы курьер проехал минимальное расстояние

class RouteOptimizer {
    // Расстояние между двумя точками (формула гаверсинуса, км)
    static haversine(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.asin(Math.sqrt(a));
    }

    // Алгоритм ближайшего соседа
    // stops: массив { lat, lon, ... }
    // startLat/startLon: точка старта (склад/база курьера)
    static optimize(stops, startLat = 59.9343, startLon = 30.3351) {
        if (!stops || stops.length === 0) return [];

        const unvisited = stops.map((s, i) => ({ ...s, _origIndex: i }));
        const route = [];
        let curLat = startLat;
        let curLon = startLon;

        while (unvisited.length > 0) {
            let nearestIdx = 0;
            let nearestDist = Infinity;

            for (let i = 0; i < unvisited.length; i++) {
                const dist = RouteOptimizer.haversine(
                    curLat, curLon,
                    unvisited[i].lat, unvisited[i].lon
                );
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestIdx = i;
                }
            }

            const nearest = unvisited.splice(nearestIdx, 1)[0];
            nearest.stop_number = route.length + 1;
            route.push(nearest);
            curLat = nearest.lat;
            curLon = nearest.lon;
        }

        return route;
    }

    // Общее расстояние маршрута (км)
    static calcDistance(stops, startLat = 59.9343, startLon = 30.3351) {
        if (!stops || stops.length < 2) return 0;

        let total = RouteOptimizer.haversine(startLat, startLon, stops[0].lat, stops[0].lon);
        for (let i = 0; i < stops.length - 1; i++) {
            total += RouteOptimizer.haversine(
                stops[i].lat, stops[i].lon,
                stops[i + 1].lat, stops[i + 1].lon
            );
        }
        return Math.round(total * 10) / 10;
    }

    // Оптимизировать маршрут и обновить stop_number
    static optimizeRoute(stops, startLat, startLon) {
        const optimized = RouteOptimizer.optimize(stops, startLat, startLon);
        optimized.forEach((stop, i) => {
            stop.stop_number = i + 1;
        });
        return optimized;
    }
}

module.exports = RouteOptimizer;
