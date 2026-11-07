/* Shop Bot Mini App: карта точек, выделение района, маршрут. */
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  // initData пуст, когда карта открыта кнопкой клавиатуры, поэтому проверяем платформу
  const inTelegram = !!(tg && tg.platform && tg.platform !== "unknown");
  // сети — нейтральными цветами: оранжевый занят под «в маршруте»
  const KNOWN_COLORS = { "пятерочка": "#f2f2f2", "pyaterochka": "#f2f2f2", "магнит": "#5aa9ff", "magnit": "#5aa9ff",
    "перекресток": "#7fd1b9", "вкусвилл": "#a8e6a1", "лента": "#c3c8ff", "дикси": "#f4b6c2" };
  const PALETTE = ["#7fd1b9", "#f4b6c2", "#c9c9c9", "#a8e6a1", "#9fd0ff"];
  const chainColors = new Map();
  function colorFor(chain) {
    const key = String(chain).toLowerCase().replace(/ё/g, "е").trim();
    if (!chainColors.has(key)) {
      const known = Object.keys(KNOWN_COLORS).find((k) => key.includes(k));
      chainColors.set(key, known ? KNOWN_COLORS[known] : PALETTE[chainColors.size % PALETTE.length]);
    }
    return chainColors.get(key);
  }
  const STATUS = {
    store: { color: "#7fd1b9", text: "Магазин найден, точка стоит на нём" },
    address: { color: "#b4b4b4", text: "Адрес подтверждён, магазина нет в базе OSM" },
    check: { color: "#ffb27a", text: "Проверить: источники расходятся" },
  };
  const MAP_ID = /^[A-Za-z0-9_-]{6,40}$/;  // в JS $ не пропускает перевод строки без флага m
  const ACCENT = "#ff6b00";
  const SPB_CENTER = [59.93, 30.33];
  const HINTS = {
    tap: "Нажимай на точки, чтобы добавить их в маршрут",
    lasso: "Обведи район пальцем, карта в этом режиме не двигается",
    radius: "Все точки в радиусе от тебя или от центра карты",
  };

  const state = {
    points: [], chain: "all", mode: "tap", travel: "foot", fromMe: true,
    selected: new Set(), myPos: null, radiusCenter: null,
  };

  const $ = (id) => document.getElementById(id);
  const map = L.map("map", { zoomControl: false, attributionControl: true }).setView(SPB_CENTER, 11);
  map.attributionControl.setPrefix(false);
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
    if (state.selected.has(p.id)) {
      return { radius: 8, color: "#fff", weight: 2, fillColor: ACCENT, fillOpacity: 1, dashArray: null };
    }
    const check = p.status === "check";
    return { radius: 5.5, color: check ? STATUS.check.color : "#000", weight: check ? 2 : 1.5,
      dashArray: check ? "2 3" : null, fillColor: colorFor(p.chain), fillOpacity: 0.95 };
  }

  function plural(n, one, few, many) {
    if (n % 10 === 1 && n % 100 !== 11) return one;
    return n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function popupHtml(p) {
    const box = el("div");
    box.append(el("div", "pop-title", p.title), el("div", "pop-chain", p.chain));
    if (p.uc != null) box.append(el("div", "pop-chain", `UC факт ${p.uc}` + (p.plan != null ? ` · ${p.plan}% плана` : "")));
    if (p.tl) box.append(el("div", "pop-chain", p.tl));
    const st = STATUS[p.status];
    if (st) {
      const row = el("div", "pop-status");
      const dot = el("i"); dot.style.background = st.color;
      row.append(dot, st.text + (p.note ? `. ${p.note}` : ""));
      box.append(row);
    }
    if (p.raw && p.raw !== p.title) box.append(el("div", "pop-raw", `В файле: ${p.raw}`));
    return box;
  }

  function renderMarkers() {
    state.points.forEach((p) => {
      const m = markers.get(p.id);
      if (visible(p)) { m.addTo(map); m.setStyle(styleFor(p)); } else { m.remove(); }
    });
    const n = state.selected.size;
    $("selNum").textContent = n;
    $("selNum").classList.toggle("on", n > 0);
    $("selLabel").textContent = `${plural(n, "точка выбрана", "точки выбрано", "точек выбрано")}`;
    $("buildBtn").disabled = n < 1;
    updateHint();
  }

  function updateHint() {
    const need = state.mode === "lasso" || (state.mode === "tap" && state.selected.size === 0);
    if (need) $("hint").textContent = HINTS[state.mode];
    if ($("hint").classList.contains("hidden") === need) {
      $("hint").classList.toggle("hidden", !need);
      map.invalidateSize();
    }
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
    $("radiusBox").classList.toggle("hidden", mode !== "radius");
    const lasso = mode === "lasso";
    $("map").classList.toggle("lasso", lasso);
    [map.dragging, map.touchZoom, map.doubleClickZoom].forEach((h) => (lasso ? h.disable() : h.enable()));
    overlay.clearLayers();
    updateHint();
    map.invalidateSize();
    if (mode === "radius") applyRadius();
  }

  // лассо
  let drawing = null;
  function latlngFromEvent(e) { return map.mouseEventToLatLng(e); }
  $("map").addEventListener("pointerdown", (e) => {
    if (state.mode !== "lasso") return;
    overlay.clearLayers();
    drawing = { pts: [latlngFromEvent(e)], line: L.polyline([], { color: ACCENT, weight: 2, dashArray: "4 5" }).addTo(overlay) };
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
    L.polygon(poly.map((p) => [p.lat, p.lon]), { color: ACCENT, weight: 1.5, fillColor: ACCENT, fillOpacity: 0.08 }).addTo(overlay);
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
    L.circle([c.lat, c.lon], { radius: r, color: ACCENT, weight: 1.5, fillColor: ACCENT, fillOpacity: 0.08 }).addTo(overlay);
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
      $("summary").innerHTML = "";
      $("summaryNote").textContent = `Выбрано ${chosen.length}, максимум ${Route.MAX_TRIP_POINTS}. Сузь район.`;
      $("summaryNote").className = "note warn";
      $("result").classList.remove("hidden");
      return;
    }
    $("buildBtn").disabled = true; $("buildBtn").textContent = "Считаю маршрут…";
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
    L.polyline(trip.geometry, { color: "#000", weight: 8, opacity: 0.7 }).addTo(routeLayer);
    L.polyline(trip.geometry, { color: ACCENT, weight: 4, opacity: 1,
      dashArray: trip.approximate ? "6 6" : null }).addTo(routeLayer);
    const shops = ordered.filter((p) => p.id !== "me");
    shops.forEach((p, i) => {
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "",
        html: `<div class="num-pin">${i + 1}</div>`, iconSize: [26, 26] }) })
        .bindPopup(popupHtml(p)).addTo(routeLayer);
    });
    map.fitBounds(L.latLngBounds(trip.geometry), { paddingTopLeft: [24, 24], paddingBottomRight: [24, Math.min(window.innerHeight * 0.4, 320)] });

    const dist = trip.legs.reduce((s, l) => s + l.distance, 0);
    const dur = trip.legs.reduce((s, l) => s + l.duration, 0);
    const km = dist / 1000;
    const mins = Math.round(dur / 60);
    const kpi = (label, value, unit) => {
      const d = el("div"); const dd = el("dd", null, value);
      if (unit) dd.append(el("small", null, unit));
      d.append(el("dt", null, label), dd); return d;
    };
    $("summary").innerHTML = "";
    $("summary").append(
      kpi("Точек", String(shops.length)),
      kpi("Путь", km < 1 ? String(Math.round(dist)) : km.toFixed(1), km < 1 ? "м" : "км"),
      kpi("В пути", mins < 60 ? String(mins) : `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`, mins < 60 ? "мин" : "ч"),
    );
    $("summaryNote").className = trip.approximate ? "note warn" : "note";
    $("summaryNote").textContent = (state.travel === "car" ? "На машине" : "Пешком") + ", без учёта времени в точках" +
      (trip.approximate ? ". Сервис маршрутов не ответил, расстояния примерные" : "");

    $("links").innerHTML = "";
    Route.yandexLinks(ordered, state.travel).forEach((l, i, all) => {
      const a = document.createElement("a");
      a.href = l.url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = all.length === 1 ? "Открыть в Яндекс Картах" : `Яндекс Карты · ${l.from}–${l.to}`;
      a.addEventListener("click", (e) => { if (tg && tg.openLink) { e.preventDefault(); tg.openLink(l.url); } });
      $("links").appendChild(a);
    });

    $("list").innerHTML = "";
    const legOffset = hasStart ? 0 : -1;
    shops.forEach((p, i) => {
      const li = el("li");
      li.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
      const body = el("div");
      const sub = el("div", "sub");
      const dot = el("i", "dot"); dot.style.background = colorFor(p.chain);
      sub.append(dot, p.chain + (p.uc != null ? ` · UC ${p.uc}` : ""));
      if (p.status === "check") sub.append(el("span", "flag", "· проверить"));
      body.append(el("div", "t", p.title), sub);
      const l = trip.legs[i + legOffset];
      li.append(el("span", "n", String(i + 1)), body, el("span", "leg", l ? `+${Route.fmtDuration(l.duration)}` : "старт"));
      $("list").appendChild(li);
    });

    state.lastRoute = { map: currentMapId(), ids: shops.map((p) => p.id), travel: state.travel, start: hasStart ? [ordered[0].lat, ordered[0].lon] : null,
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
  $("locateBtn").addEventListener("click", async () => {
    const me = await locate();
    if (me) map.setView([me.lat, me.lon], 14);
    else { $("hint").textContent = "Не получилось определить, где ты. Разреши доступ к геолокации."; $("hint").classList.remove("hidden"); map.invalidateSize(); }
  });
  $("buildBtn").addEventListener("click", build);
  $("sendBtn").addEventListener("click", () => { if (tg && state.lastRoute) tg.sendData(JSON.stringify(state.lastRoute)); });

  /* ---------- старт ---------- */
  if (tg) { tg.ready(); tg.expand(); }
  function buildChips(points) {
    const chains = [...new Set(points.map((p) => p.chain))];
    const box = $("chainChips");
    box.innerHTML = "";
    const mk = (value, label, color) => {
      const b = document.createElement("button");
      b.dataset.chain = value;
      if (color) { const i = document.createElement("i"); i.className = "dot"; i.style.background = color; b.appendChild(i); }
      b.append(label);
      if (value === "all") b.classList.add("on");
      box.appendChild(b);
    };
    if (chains.length < 2) return;   // одна сеть — фильтр не нужен
    mk("all", "Все");
    chains.forEach((c) => mk(c, c, colorFor(c)));
  }

  function currentMapId() {
    const id = new URLSearchParams(location.search).get("map");
    return id && MAP_ID.test(id) ? id : null;
  }

  function source() {
    const id = currentMapId();
    return id ? `maps/${id}.json` : "points.json";
  }

  fetch(source(), { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      state.points = data.points;
      buildChips(data.points);
      data.points.forEach((p) => {
        const m = L.circleMarker([p.lat, p.lon], styleFor(p)).bindTooltip(document.createTextNode(p.title)).bindPopup(popupHtml(p));
        m.on("click", () => { if (state.mode === "tap") toggle(p.id); });
        markers.set(p.id, m);
      });
      if (data.points.length) map.fitBounds(L.latLngBounds(data.points.map((p) => [p.lat, p.lon])), { padding: [30, 30] });
      const warn = data.points.filter((p) => p.status === "check").length;
      const n = data.points.length;
      $("title").textContent = data.city || data.title || "Карта точек";
      $("meta").textContent = `${n} ${plural(n, "точка", "точки", "точек")}`;
      if (warn) $("meta").append(" · ", el("b", null, `${warn} проверить`));
      renderMarkers();
    })
    .catch(() => { $("meta").textContent = "Не удалось загрузить точки. Обнови страницу."; });
})();
