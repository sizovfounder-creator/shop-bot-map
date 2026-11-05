/* Shop Bot Mini App: карта точек, выделение района, маршрут. */
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  // initData пуст, когда карта открыта кнопкой клавиатуры, поэтому проверяем платформу
  const inTelegram = !!(tg && tg.platform && tg.platform !== "unknown");
  const COLORS = { "Пятерочка": "#d6262c", "Магнит": "#1f6fd1" };
  const ROUTE_COLOR = "#7c3aed";
  const SPB_CENTER = [59.93, 30.33];
  const HINTS = {
    tap: "Тапай по точкам, чтобы добавить их в маршрут",
    lasso: "Обведи район пальцем, карта в этом режиме не двигается",
    radius: "Все точки в радиусе от тебя или от центра карты",
  };

  const state = {
    points: [], chain: "all", mode: "tap", travel: "foot", fromMe: true,
    selected: new Set(), myPos: null, radiusCenter: null,
  };

  const $ = (id) => document.getElementById(id);
  const map = L.map("map", { zoomControl: false, attributionControl: true }).setView(SPB_CENTER, 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap",
  }).addTo(map);

  const markers = new Map();
  const overlay = L.layerGroup().addTo(map);   // лассо / радиус
  const routeLayer = L.layerGroup().addTo(map);
  let meMarker = null;

  /* ---------- точки ---------- */
  function visible(p) { return state.chain === "all" || p.chain === state.chain; }

  function styleFor(p) {
    const on = state.selected.has(p.id);
    return { radius: on ? 8 : 6, color: on ? "#111" : "#fff", weight: on ? 3 : 1.5,
      fillColor: COLORS[p.chain], fillOpacity: on ? 1 : 0.85 };
  }

  function popupHtml(p) {
    const el = document.createElement("div");
    const t = document.createElement("b"); t.textContent = `${p.chain}: ${p.title}`;
    el.appendChild(t);
    if (p.uc != null) {
      const s = document.createElement("div");
      s.textContent = `UC факт: ${p.uc}` + (p.plan != null ? ` · ${p.plan}% плана` : "");
      el.appendChild(s);
    }
    if (p.tl) { const s = document.createElement("div"); s.textContent = `TL: ${p.tl}`; el.appendChild(s); }
    return el;
  }

  function renderMarkers() {
    state.points.forEach((p) => {
      const m = markers.get(p.id);
      if (visible(p)) { m.addTo(map); m.setStyle(styleFor(p)); } else { m.remove(); }
    });
    const n = state.selected.size;
    $("selCount").textContent = `Выбрано: ${n}`;
    $("buildBtn").disabled = n < 1;
  }

  function setSelection(ids) {
    state.selected = new Set(ids);
    clearRoute();
    renderMarkers();
  }

  function toggle(id) {
    const next = new Set(state.selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelection(next);
  }

  /* ---------- режимы ---------- */
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("hint").textContent = HINTS[mode];
    $("radiusBox").classList.toggle("hidden", mode !== "radius");
    const lasso = mode === "lasso";
    $("map").classList.toggle("lasso", lasso);
    [map.dragging, map.touchZoom, map.doubleClickZoom].forEach((h) => (lasso ? h.disable() : h.enable()));
    overlay.clearLayers();
    if (mode === "radius") applyRadius();
  }

  // лассо
  let drawing = null;
  function latlngFromEvent(e) { return map.mouseEventToLatLng(e); }
  $("map").addEventListener("pointerdown", (e) => {
    if (state.mode !== "lasso") return;
    overlay.clearLayers();
    drawing = { pts: [latlngFromEvent(e)], line: L.polyline([], { color: "#111", weight: 2, dashArray: "4 4" }).addTo(overlay) };
    $("map").setPointerCapture(e.pointerId);
  });
  $("map").addEventListener("pointermove", (e) => {
    if (!drawing) return;
    drawing.pts = [...drawing.pts, latlngFromEvent(e)];
    drawing.line.setLatLngs(drawing.pts);
  });
  $("map").addEventListener("pointerup", () => {
    if (!drawing) return;
    const poly = drawing.pts.map((ll) => ({ lat: ll.lat, lon: ll.lng }));
    overlay.clearLayers();
    drawing = null;
    if (poly.length < 3) return;
    L.polygon(poly.map((p) => [p.lat, p.lon]), { color: "#111", weight: 2, fillOpacity: 0.06 }).addTo(overlay);
    const ids = state.points.filter((p) => visible(p) && Route.insidePolygon(p, poly)).map((p) => p.id);
    setSelection(ids);
  });

  // радиус
  function applyRadius() {
    const r = Number($("radius").value);
    $("radiusVal").textContent = Route.fmtDistance(r);
    const c = state.radiusCenter || (state.myPos ? state.myPos : { lat: map.getCenter().lat, lon: map.getCenter().lng });
    state.radiusCenter = c;
    overlay.clearLayers();
    L.circle([c.lat, c.lon], { radius: r, color: "#111", weight: 2, fillOpacity: 0.06 }).addTo(overlay);
    setSelection(state.points.filter((p) => visible(p) && Route.haversine(c, p) <= r).map((p) => p.id));
  }

  /* ---------- геолокация ---------- */
  function locate() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.myPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          if (meMarker) meMarker.remove();
          meMarker = L.marker([state.myPos.lat, state.myPos.lon], {
            icon: L.divIcon({ className: "", html: '<div class="me-pin"></div>', iconSize: [16, 16] }),
          }).addTo(map);
          resolve(state.myPos);
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });
  }

  /* ---------- маршрут ---------- */
  function clearRoute() {
    routeLayer.clearLayers();
    $("result").classList.add("hidden");
  }

  // если стартуем не от себя — начинаем с крайней точки (самой дальней от центра выборки)
  function pickEdgeStart(pts) {
    const c = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length };
    const far = pts.reduce((best, p) => (Route.haversine(c, p) > Route.haversine(c, best) ? p : best), pts[0]);
    return [far, ...pts.filter((p) => p !== far)];
  }

  async function build() {
    const chosen = state.points.filter((p) => state.selected.has(p.id));
    if (chosen.length > Route.MAX_TRIP_POINTS) {
      $("summary").textContent = `Выбрано ${chosen.length}, максимум ${Route.MAX_TRIP_POINTS}. Сузь район.`;
      $("result").classList.remove("hidden");
      return;
    }
    $("buildBtn").disabled = true; $("buildBtn").textContent = "Считаю…";
    const me = state.fromMe ? (state.myPos || (await locate())) : null;
    const start = me ? { id: "me", title: "Старт: я здесь", lat: me.lat, lon: me.lon } : null;
    const pts = start ? [start, ...chosen] : pickEdgeStart(chosen);

    const trip = await Route.buildTrip(pts, state.travel, window.fetch.bind(window));
    const ordered = trip.order.map((i) => pts[i]);
    renderRoute(ordered, trip, !!start);
    $("buildBtn").disabled = false; $("buildBtn").textContent = "Построить маршрут";
  }

  function renderRoute(ordered, trip, hasStart) {
    routeLayer.clearLayers();
    // подложка светлая в любой теме, поэтому линия всегда тёмная с белой обводкой
    L.polyline(trip.geometry, { color: "#fff", weight: 8, opacity: 0.9 }).addTo(routeLayer);
    L.polyline(trip.geometry, { color: ROUTE_COLOR, weight: 4, opacity: 0.9,
      dashArray: trip.approximate ? "6 6" : null }).addTo(routeLayer);
    const shops = ordered.filter((p) => p.id !== "me");
    shops.forEach((p, i) => {
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "",
        html: `<div class="num-pin" style="background:${COLORS[p.chain]}">${i + 1}</div>`, iconSize: [24, 24] }) })
        .bindPopup(popupHtml(p)).addTo(routeLayer);
    });
    map.fitBounds(L.latLngBounds(trip.geometry), { paddingTopLeft: [20, 140], paddingBottomRight: [20, window.innerHeight * 0.45] });

    const dist = trip.legs.reduce((s, l) => s + l.distance, 0);
    const dur = trip.legs.reduce((s, l) => s + l.duration, 0);
    $("summary").innerHTML = "";
    $("summary").append(`${shops.length} точек · ${Route.fmtDistance(dist)} · ${Route.fmtDuration(dur)}`);
    const sub = document.createElement("small");
    sub.textContent = (state.travel === "car" ? "на машине" : "пешком") + ", без учёта времени в точках" +
      (trip.approximate ? ". Сервер маршрутов не ответил, расстояния примерные" : "");
    $("summary").appendChild(sub);

    $("links").innerHTML = "";
    Route.yandexLinks(ordered, state.travel).forEach((l, i, all) => {
      const a = document.createElement("a");
      a.href = l.url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = all.length === 1 ? "Открыть в Яндекс Картах" : `Яндекс: часть ${i + 1}`;
      a.addEventListener("click", (e) => { if (tg && tg.openLink) { e.preventDefault(); tg.openLink(l.url); } });
      $("links").appendChild(a);
    });

    $("list").innerHTML = "";
    const legOffset = hasStart ? 0 : -1;
    shops.forEach((p, i) => {
      const li = document.createElement("li");
      const n = document.createElement("span"); n.className = "n"; n.style.background = COLORS[p.chain]; n.textContent = i + 1;
      const body = document.createElement("div");
      const t = document.createElement("div"); t.textContent = p.title;
      const s = document.createElement("div"); s.className = "sub"; s.textContent = p.chain + (p.uc != null ? ` · UC ${p.uc}` : "");
      body.append(t, s);
      const leg = document.createElement("span"); leg.className = "leg";
      const l = trip.legs[i + legOffset];
      leg.textContent = l ? `+${Route.fmtDuration(l.duration)}` : "старт";
      li.append(n, body, leg);
      $("list").appendChild(li);
    });

    state.lastRoute = { ids: shops.map((p) => p.id), travel: state.travel, start: hasStart ? [ordered[0].lat, ordered[0].lon] : null,
      km: +(dist / 1000).toFixed(1), min: Math.round(dur / 60), approx: trip.approximate };
    $("sendBtn").classList.toggle("hidden", !inTelegram);
    $("result").classList.remove("hidden");
  }

  /* ---------- UI ---------- */
  function bindSeg(id, attr, fn) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      fn(b.dataset[attr]);
    });
  }
  bindSeg("chainChips", "chain", (c) => { state.chain = c; setSelection([...state.selected].filter((id) => visible(state.points.find((p) => p.id === id)))); });
  bindSeg("modeSeg", "mode", setMode);
  bindSeg("travelSeg", "travel", (t) => { state.travel = t; clearRoute(); });
  $("fromMe").addEventListener("change", (e) => { state.fromMe = e.target.checked; clearRoute(); });
  $("radius").addEventListener("input", applyRadius);
  $("radiusHere").addEventListener("click", async () => {
    const me = await locate();
    state.radiusCenter = me || { lat: map.getCenter().lat, lon: map.getCenter().lng };
    if (me) map.setView([me.lat, me.lon], 14);
    applyRadius();
  });
  $("clearBtn").addEventListener("click", () => { overlay.clearLayers(); setSelection([]); });
  $("buildBtn").addEventListener("click", build);
  $("sendBtn").addEventListener("click", () => { if (tg && state.lastRoute) tg.sendData(JSON.stringify(state.lastRoute)); });

  /* ---------- старт ---------- */
  if (tg) { tg.ready(); tg.expand(); }
  fetch("points.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      state.points = data.points;
      data.points.forEach((p) => {
        const m = L.circleMarker([p.lat, p.lon], styleFor(p)).bindTooltip(p.title);
        m.on("click", () => { if (state.mode === "tap") toggle(p.id); });
        markers.set(p.id, m);
      });
      renderMarkers();
    })
    .catch(() => { $("hint").textContent = "Не удалось загрузить точки. Обнови страницу."; });
})();
