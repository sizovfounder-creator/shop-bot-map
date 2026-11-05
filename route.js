/* Чистые функции маршрутизации. Работают и в браузере, и в node (для тестов). */
(function (root) {
  const OSRM = {
    foot: "https://routing.openstreetmap.de/routed-foot",
    car: "https://routing.openstreetmap.de/routed-car",
  };
  const MAX_TRIP_POINTS = 90;      // больше публичный сервер может не принять
  const LINK_CHUNK = 10;           // точек в одной ссылке на Яндекс Карты
  const FALLBACK_SPEED = { foot: 1.25, car: 7 }; // м/с, если сервер маршрутов недоступен

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ray casting; polygon — массив {lat, lon}
  function insidePolygon(pt, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      const crosses = (a.lat > pt.lat) !== (b.lat > pt.lat) &&
        pt.lon < ((b.lon - a.lon) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lon;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function pathLength(order, pts) {
    let d = 0;
    for (let i = 1; i < order.length; i++) d += haversine(pts[order[i - 1]], pts[order[i]]);
    return d;
  }

  // запасной вариант: ближайший сосед + 2-opt, старт фиксирован (индекс 0), без возврата
  function localOrder(pts) {
    if (pts.length < 3) return pts.map((_, i) => i);
    const left = new Set(pts.map((_, i) => i).slice(1));
    let order = [0];
    while (left.size) {
      const last = pts[order[order.length - 1]];
      let best = null, bestD = Infinity;
      left.forEach((i) => { const d = haversine(last, pts[i]); if (d < bestD) { bestD = d; best = i; } });
      order = [...order, best];
      left.delete(best);
    }
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < order.length - 1; i++) {
        for (let k = i + 1; k < order.length; k++) {
          const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
          if (pathLength(cand, pts) + 0.5 < pathLength(order, pts)) { order = cand; improved = true; }
        }
      }
    }
    return order;
  }

  function fallbackTrip(pts, travel) {
    const order = localOrder(pts);
    const legs = order.slice(1).map((idx, i) => {
      const distance = haversine(pts[order[i]], pts[idx]) * 1.3; // поправка на «не по прямой»
      return { distance, duration: distance / FALLBACK_SPEED[travel] };
    });
    return { order, legs, geometry: order.map((i) => [pts[i].lat, pts[i].lon]), approximate: true };
  }

  async function osrmTrip(pts, travel, fetchImpl) {
    const coords = pts.map((p) => `${p.lon},${p.lat}`).join(";");
    const url = `${OSRM[travel]}/trip/v1/driving/${coords}` +
      "?source=first&roundtrip=false&overview=full&geometries=geojson";
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`routing HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== "Ok" || !data.trips || !data.trips.length) throw new Error(`routing ${data.code}`);
    const order = data.waypoints
      .map((w, inputIdx) => ({ inputIdx, pos: w.waypoint_index }))
      .sort((a, b) => a.pos - b.pos)
      .map((w) => w.inputIdx);
    const trip = data.trips[0];
    return {
      order,
      legs: trip.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
      geometry: trip.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      approximate: false,
    };
  }

  // pts[0] — старт. Возвращает порядок индексов pts, отрезки и линию.
  async function buildTrip(pts, travel, fetchImpl) {
    if (pts.length > MAX_TRIP_POINTS) throw new Error(`Слишком много точек: максимум ${MAX_TRIP_POINTS}`);
    try {
      return await osrmTrip(pts, travel, fetchImpl);
    } catch (err) {
      return { ...fallbackTrip(pts, travel), error: String(err.message || err) };
    }
  }

  // ссылки на Яндекс Карты кусками; соседние куски стыкуются общей точкой
  function yandexLinks(ordered, travel) {
    const rtt = travel === "car" ? "auto" : "pd";
    const links = [];
    for (let s = 0; s < ordered.length - 1; s += LINK_CHUNK - 1) {
      const part = ordered.slice(s, s + LINK_CHUNK);
      const rtext = part.map((p) => `${p.lat},${p.lon}`).join("~");
      links.push({ from: s + 1, to: s + part.length, url: `https://yandex.ru/maps/?rtext=${rtext}&rtt=${rtt}` });
    }
    return links;
  }

  function fmtDistance(m) { return m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(1)} км`; }
  function fmtDuration(s) {
    const min = Math.round(s / 60);
    return min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`;
  }

  const api = { haversine, insidePolygon, localOrder, buildTrip, yandexLinks, fmtDistance, fmtDuration, MAX_TRIP_POINTS };
  if (typeof module !== "undefined") module.exports = api; else root.Route = api;
})(this);
