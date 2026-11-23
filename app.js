/* БОС · Аналитика.
   Классический скрипт (не ES-модуль), чтобы приложение работало и при открытии
   index.html напрямую с диска. */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Конфигурация
  // ---------------------------------------------------------------------------
  const CONFIG = {
    sheetId: "1mDdg8Z1KpH8iDbf9PMnqnEA0dp_FZY1T1ab0RpY0etM",
    sheetName: "data",
    // Ключ API Яндекс.Карт: https://developer.tech.yandex.ru/services/
    // Без ключа вкладка «Карта» показывает инструкцию вместо пустой карты.
    mapsApiKey: (window.BOS_CONFIG && window.BOS_CONFIG.mapsApiKey) || "",
    // Бесплатный тариф JS API считает загрузки карты; при достижении лимита
    // автозагрузка останавливается (счётчик локальный, см. README-рекомендации).
    mapsDailyLimit: 100,
    stateKey: "bos_analytics_state",
    cacheKey: "bos_analytics_cache",
    cacheTtlMs: 10 * 60 * 1000,
    sheetTimeoutMs: 20000,
  };

  const FILTER_KEYS = ["fo", "obj", "category", "status"];

  // ---------------------------------------------------------------------------
  // Утилиты
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const NUM_FMT = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const fmt = (v) =>
    typeof v === "number" && Number.isFinite(v) ? NUM_FMT.format(v) : v || "";
  const showNum = (v) => (typeof v === "number" && v !== 0 ? fmt(v) : "");

  const ESC_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ESC_MAP[m]);

  const safeUrl = (u) => {
    const raw = String(u ?? "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw, window.location.href);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  };

  const linkify = (s) =>
    String(s ?? "")
      .split(/(https?:\/\/[^\s]+)/g)
      .map((part) => {
        if (!/^https?:\/\//.test(part)) return esc(part);
        const href = safeUrl(part);
        return href
          ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="raw-link">${esc(part)}</a>`
          : esc(part);
      })
      .join("");

  const debounce = (fn, ms) => {
    let t = 0;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  const plural = (n, forms) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  };

  const parseNumStrict = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return null;
    const s = String(v)
      .replace(/[\s\u00A0]/g, "")
      .replace(",", ".");
    if (s === "" || s === "-" || s === "—") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };

  function showToast(message, type = "info", timeout = 5000) {
    const host = $("toast-container");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const remove = () => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    };
    if (timeout > 0) setTimeout(remove, timeout);
    el.addEventListener("click", remove);
  }

  // ---------------------------------------------------------------------------
  // Статусы
  // ---------------------------------------------------------------------------
  const STATUS_ORDER = [
    "Завершено",
    "В работе",
    "Утрачен",
    "Поврежден",
    "Отказ",
  ];
  const STATUS_CONF = {
    Завершено: { color: "var(--success)", hex: "#10b981", badge: "delivered" },
    "В работе": { color: "var(--info)", hex: "#0ea5e9", badge: "planned" },
    Утрачен: { color: "var(--danger)", hex: "#ef4444", badge: "danger" },
    Поврежден: { color: "var(--warning)", hex: "#f59e0b", badge: "warning" },
    Отказ: { color: "#64748b", hex: "#64748b", badge: "gray" },
  };
  const STATUS_ALIASES = {
    завершен: "Завершено",
    завершено: "Завершено",
    сдан: "Завершено",
    сдано: "Завершено",
    "в работе": "В работе",
    строится: "В работе",
    утрачен: "Утрачен",
    утрачено: "Утрачен",
    поврежден: "Поврежден",
    "поврежден частично": "Поврежден",
    повреждено: "Поврежден",
    отказ: "Отказ",
    "отказ от строительства": "Отказ",
  };
  const canonicalStatus = (v) => {
    const s = String(v ?? "").trim();
    if (!s) return "Не указан";
    return STATUS_ALIASES[s.toLowerCase()] || s;
  };
  const statusConf = (s) =>
    STATUS_CONF[s] || { color: "#94a3b8", hex: "#94a3b8", badge: "gray" };

  // ---------------------------------------------------------------------------
  // Колонки
  // ---------------------------------------------------------------------------
  const COLUMN_DEFS = [
    { key: "obj", label: "Объект / Этап", class: "text-left", width: 34 },
    { key: "category", label: "Категория", class: "text-left", width: 20 },
    { key: "status", label: "Статус", class: "text-center", width: 16 },
    {
      key: "areaBuild",
      label: "Стройка",
      class: "text-right",
      numeric: true,
      bold: true,
      width: 16,
    },
    {
      key: "areaMezzanine",
      label: "Мезонин",
      class: "text-right",
      numeric: true,
      width: 16,
    },
    {
      key: "areaOper",
      label: "Оперзона",
      class: "text-right",
      numeric: true,
      width: 16,
    },
    {
      key: "areaFreeze",
      label: "Заморозка",
      class: "text-right",
      numeric: true,
      bold: true,
      width: 16,
    },
    { key: "rvText", label: "РВ (Дата)", class: "text-center", width: 18 },
    { key: "source", label: "Источник данных", class: "text-left", width: 24 },
    { key: "damage", label: "Повреждения", class: "text-left", width: 22 },
  ];
  const DEFAULT_COLUMNS = [
    "obj",
    "category",
    "status",
    "areaBuild",
    "areaMezzanine",
    "areaOper",
    "areaFreeze",
    "rvText",
  ];

  // ---------------------------------------------------------------------------
  // Состояние
  // ---------------------------------------------------------------------------
  const state = {
    allData: [],
    rawData: [],
    filteredData: [],
    filters: { fo: null, obj: null, category: null, status: null },
    seen: {
      fo: new Set(),
      obj: new Set(),
      category: new Set(),
      status: new Set(),
    },
    sort: { col: null, dir: 1 },
    showBVS: true,
    selectedYear: new Date().getFullYear(),
    columnOrder: [...DEFAULT_COLUMNS],
    visible: new Set(DEFAULT_COLUMNS),
    map: null,
    markersLayer: null,
    mapLoading: null,
    mapForceLoad: false,
    compare: { left: null, right: null, mode: "g_vs_x", result: null },
  };

  // ---------------------------------------------------------------------------
  // Сохранение настроек
  // ---------------------------------------------------------------------------
  function persistState() {
    try {
      const filters = {};
      const seen = {};
      for (const k of FILTER_KEYS) {
        filters[k] = state.filters[k] ? [...state.filters[k]] : null;
        seen[k] = [...(state.seen[k] || [])];
      }
      localStorage.setItem(
        CONFIG.stateKey,
        JSON.stringify({
          showBVS: state.showBVS,
          columns: state.columnOrder,
          visible: [...state.visible],
          filters,
          seen,
          selectedYear: state.selectedYear,
        }),
      );
    } catch (e) {
      console.warn("Не удалось сохранить настройки", e);
    }
  }
  const saveState = debounce(persistState, 250);

  function loadState() {
    try {
      const saved = localStorage.getItem(CONFIG.stateKey);
      if (!saved) return;
      const s = JSON.parse(saved);
      if (typeof s.showBVS === "boolean") state.showBVS = s.showBVS;
      if (
        Array.isArray(s.columns) &&
        s.columns.every((c) => typeof c === "string")
      ) {
        const known = COLUMN_DEFS.map((d) => d.key);
        const ordered = s.columns.filter((k) => known.includes(k));
        if (Array.isArray(s.visible)) {
          state.columnOrder = ordered;
          state.visible = new Set(s.visible.filter((k) => known.includes(k)));
        } else {
          state.visible = new Set(ordered);
          state.columnOrder = [
            ...ordered,
            ...known.filter((k) => !ordered.includes(k)),
          ];
        }
      }
      if (s.filters) {
        for (const k of FILTER_KEYS) {
          const v = s.filters[k];
          state.filters[k] = Array.isArray(v) ? new Set(v) : null;
        }
      }
      if (s.seen) {
        for (const k of FILTER_KEYS) {
          if (Array.isArray(s.seen[k])) state.seen[k] = new Set(s.seen[k]);
        }
      }
      if (Number.isInteger(s.selectedYear)) state.selectedYear = s.selectedYear;
    } catch (e) {
      console.error("Ошибка загрузки настроек", e);
      localStorage.removeItem(CONFIG.stateKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Менеджер столбцов
  // ---------------------------------------------------------------------------
  const defsByKey = new Map(COLUMN_DEFS.map((d) => [d.key, d]));

  function orderedColumnDefs() {
    const keys = [
      ...state.columnOrder,
      ...COLUMN_DEFS.map((d) => d.key).filter(
        (k) => !state.columnOrder.includes(k),
      ),
    ];
    return keys.map((k) => defsByKey.get(k)).filter(Boolean);
  }
  const visibleColumnDefs = () =>
    orderedColumnDefs().filter((d) => state.visible.has(d.key));

  function renderColumnsManager() {
    const list = $("dnd-columns");
    if (!list) return;
    list.innerHTML = orderedColumnDefs()
      .map((col) => {
        const checked = state.visible.has(col.key) ? "checked" : "";
        return `<div class="dnd-item" draggable="true" data-key="${col.key}">
      <span class="dnd-handle" aria-hidden="true">☰</span>
      <input type="checkbox" data-col-key="${col.key}" ${checked} aria-label="Показывать столбец «${esc(col.label)}»">
      <span class="dnd-label">${esc(col.label)}</span>
      <span class="dnd-move">
        <button type="button" data-move="-1" aria-label="Поднять «${esc(col.label)}»">▲</button>
        <button type="button" data-move="1" aria-label="Опустить «${esc(col.label)}»">▼</button>
      </span>
    </div>`;
      })
      .join("");
  }

  function setColumnVisible(key, checked) {
    if (checked) state.visible.add(key);
    else state.visible.delete(key);
    if (!state.columnOrder.includes(key)) state.columnOrder.push(key);
    renderTable();
    saveState();
  }

  function moveColumn(key, delta) {
    const order = state.columnOrder;
    const from = order.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(from, 1);
    order.splice(to, 0, key);
    renderColumnsManager();
    renderTable();
    saveState();
  }

  function reorderColumn(srcKey, targetKey) {
    const order = state.columnOrder;
    const from = order.indexOf(srcKey);
    const to = order.indexOf(targetKey);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(from < to ? to - 1 : to, 0, srcKey);
    renderColumnsManager();
    renderTable();
    saveState();
  }

  function initColumnsManager() {
    const list = $("dnd-columns");
    if (!list) return;
    list.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-col-key]");
      if (cb) setColumnVisible(cb.dataset.colKey, cb.checked);
    });
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-move]");
      if (!btn) return;
      e.preventDefault();
      moveColumn(
        btn.closest(".dnd-item").dataset.key,
        Number(btn.dataset.move),
      );
    });
    let dragSrcEl = null;
    list.addEventListener("dragstart", (e) => {
      const item = e.target.closest(".dnd-item");
      if (!item) return;
      dragSrcEl = item;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.dataset.key);
      item.classList.add("dragging");
    });
    list.addEventListener("dragend", () => {
      if (dragSrcEl) dragSrcEl.classList.remove("dragging");
      dragSrcEl = null;
    });
    list.addEventListener("dragover", (e) => {
      if (!dragSrcEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    list.addEventListener("drop", (e) => {
      const item = e.target.closest(".dnd-item");
      if (!item || !dragSrcEl) return;
      e.preventDefault();
      reorderColumn(dragSrcEl.dataset.key, item.dataset.key);
    });
    renderColumnsManager();
  }

  // ---------------------------------------------------------------------------
  // Загрузка Google Sheets (JSONP через gviz)
  // ---------------------------------------------------------------------------
  let gvizSeq = 0;

  function loadGoogleSheet(id = CONFIG.sheetId, name = CONFIG.sheetName) {
    return new Promise((resolve, reject) => {
      const cbName = `__bosGviz_${++gvizSeq}_${Math.random().toString(36).slice(2, 8)}`;
      const script = document.createElement("script");
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.remove();
        try {
          delete window[cbName];
        } catch {
          window[cbName] = undefined;
        }
        fn(value);
      };

      const timer = setTimeout(
        () => finish(reject, new Error("Таймаут загрузки Google Sheets")),
        CONFIG.sheetTimeoutMs,
      );

      window[cbName] = (data) => {
        if (!data || !data.table) {
          finish(reject, new Error("Пустой ответ Google Sheets"));
          return;
        }
        try {
          finish(resolve, parseGviz(data));
        } catch (e) {
          finish(reject, e);
        }
      };

      script.src =
        `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq` +
        `?tqx=responseHandler:${cbName}&sheet=${encodeURIComponent(name)}&headers=1`;
      script.onerror = () =>
        finish(reject, new Error("Сеть недоступна или лист закрыт для чтения"));
      document.head.appendChild(script);
    });
  }

  function parseGviz(data) {
    const t = data.table;
    const headers = t.cols.map((c) =>
      (c.label || c.id || "").replace(/\s+/g, " ").trim(),
    );
    const rows = [];
    (t.rows || []).forEach((r, idx) => {
      const obj = { __row: idx + 2 };
      let hasValue = false;
      (r.c || []).forEach((cell, i) => {
        if (i >= headers.length || !headers[i]) return;
        let v = null;
        let link = null;
        if (cell) {
          if (cell.p && cell.p.html) {
            const match = cell.p.html.match(/href="([^"]+)"/);
            if (match) link = match[1].replace(/&amp;/g, "&");
          }
          if (!link && cell.hyperlink) link = cell.hyperlink;
          if (!link && typeof cell.f === "string") {
            const match = cell.f.match(/href="([^"]+)"/);
            if (match) link = match[1].replace(/&amp;/g, "&");
          }
          if (
            !link &&
            typeof cell.v === "string" &&
            /^https?:\/\//.test(cell.v.trim())
          ) {
            link = cell.v.trim();
          }

          if (cell.v !== undefined && cell.v !== null && cell.v !== "") {
            const raw = cell.v;
            if (typeof raw === "string" && raw.startsWith("Date(")) {
              const m = raw.match(/Date\((\d+),(\d+),(\d+)/);
              if (m) {
                v = `${String(parseInt(m[3], 10)).padStart(2, "0")}.${String(
                  parseInt(m[2], 10) + 1,
                ).padStart(2, "0")}.${m[1]}`;
              }
            } else {
              v = raw;
            }
          } else if (cell.f) {
            v = String(cell.f)
              .replace(/<[^>]+>/g, "")
              .trim();
          }
          if (!link && typeof v === "string" && /^https?:\/\//.test(v))
            link = v;
        }
        obj[headers[i]] = v;
        if (link) obj[headers[i] + "_link"] = link;
        if (v !== null && v !== "") hasValue = true;
      });
      if (hasValue) rows.push(obj);
    });
    return { headers: headers.filter(Boolean), rows };
  }

  // ---------------------------------------------------------------------------
  // Нормализация строк листа
  // ---------------------------------------------------------------------------
  function processData(headers, rows) {
    return rows.map((r) => {
      const getVal = (k) => (r[k] !== undefined ? r[k] : null);
      const area = (k) => {
        const n = parseNumStrict(getVal(k));
        return n === null || Number.isNaN(n) ? 0 : n;
      };

      const rvText = getVal("РВ") ? String(getVal("РВ")) : "";
      const rvLink =
        getVal("Ссылка РВ") ||
        getVal("РВ_link") ||
        getVal("Ссылка") ||
        getVal("URL") ||
        null;

      let cleanRvText = rvText;
      if (rvLink && rvText.includes(rvLink)) {
        cleanRvText = rvText.replace(rvLink, "").trim() || "Ссылка";
      }

      let date = null;
      const dMatch = cleanRvText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (dMatch) date = new Date(+dMatch[3], +dMatch[2] - 1, +dMatch[1]);

      const rawStatus =
        getVal("статус площадки") || getVal("статус") || "Не указан";
      const status = canonicalStatus(rawStatus);
      let category = getVal("категория") || getVal("категория объекта") || "";
      if (category === "Вспомогательные объекты") category = "Прочее";

      const areaKeys = [
        "площадь блоков мезонина",
        "площадь оперзоны",
        "площадь заморозки",
        "площадь строительства",
      ];
      const badArea = areaKeys.some((k) => {
        const n = parseNumStrict(getVal(k));
        return n !== null && Number.isNaN(n);
      });

      return {
        id: getVal("id") || "—",
        fo: getVal("ФО") || "",
        obj: getVal("объект") || "",
        stage: getVal("этап") || "",
        status,
        category,
        areaMezzanine: area("площадь блоков мезонина"),
        areaOper: area("площадь оперзоны"),
        areaFreeze: area("площадь заморозки"),
        areaBuild: area("площадь строительства"),
        source: getVal("источник данных площади") || "",
        damage: getVal("повреждения") || "",
        rvText: cleanRvText,
        rvLink,
        rvDate: date,
        rvSort: date ? date.getTime() : 0,
        badArea,
        isBVS:
          String(getVal("категория") || "").includes("БВС") ||
          String(getVal("объект") || "").includes("БВС") ||
          String(getVal("этап") || "").includes("БВС"),
      };
    });
  }

  function stageLabel(r) {
    let s = r.stage || "";
    if (s && r.obj) {
      const escapedObj = r.obj.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      s = s.replace(new RegExp(escapedObj, "i"), "");
    }
    s = s.replace(/^[\s\-()]+|[\s\-()]+$/g, "").trim();
    if (/^абч$/i.test(s)) s = "(АБЧ)";
    else if (/^бвс$/i.test(s)) s = "(БВС)";
    if (s === r.obj) s = "";
    return s;
  }

  // ---------------------------------------------------------------------------
  // Фильтры
  // ---------------------------------------------------------------------------
  const allValues = (key, data) =>
    [...new Set(data.map((r) => r[key]).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b), "ru"),
    );

  function renderFilterOptions() {
    for (const key of FILTER_KEYS) {
      const box = $("filter-" + key);
      if (!box) continue;
      const selected = state.filters[key] || new Set();
      const values = allValues(key, state.rawData);
      box.innerHTML = values.length
        ? values
            .map(
              (v) =>
                `<label class="checkbox-item"><input type="checkbox" data-filter="${key}" value="${esc(
                  v,
                )}" ${selected.has(v) ? "checked" : ""} /><span>${esc(v)}</span></label>`,
            )
            .join("")
        : '<div class="filter-empty">Нет значений</div>';
    }
  }

  function setFilterAll(key, all) {
    state.filters[key] = all
      ? new Set(allValues(key, state.rawData))
      : new Set();
    renderFilterOptions();
    applyFilters();
    saveState();
  }

  function applyFilters() {
    const f = state.filters;
    state.filteredData = state.rawData.filter((r) =>
      FILTER_KEYS.every((k) => !f[k] || f[k].has(r[k])),
    );

    if (state.sort.col) {
      const col = state.sort.col;
      const dir = state.sort.dir;
      state.filteredData.sort((a, b) => {
        let va = col === "rvText" ? a.rvSort : a[col];
        let vb = col === "rvText" ? b.rvSort : b[col];
        if (va === null || va === undefined || va === "") va = "";
        if (vb === null || vb === undefined || vb === "") vb = "";
        if (typeof va === "number" && typeof vb === "number")
          return (va - vb) * dir;
        return String(va).localeCompare(String(vb), "ru") * dir;
      });
    }
    renderTable();
  }

  function processAllData() {
    state.rawData = state.showBVS
      ? state.allData
      : state.allData.filter((r) => !r.isBVS);

    for (const key of FILTER_KEYS) {
      const values = allValues(key, state.rawData);
      if (!state.seen[key]) state.seen[key] = new Set();
      if (!state.filters[key]) state.filters[key] = new Set(values);
      for (const v of values) {
        if (!state.seen[key].has(v)) {
          state.seen[key].add(v);
          state.filters[key].add(v);
        }
      }
    }

    renderFilterOptions();
    applyFilters();
    renderDashboard(state.rawData);
    updateMap();
  }

  function drillDown(type) {
    activateTab("table");
    for (const key of FILTER_KEYS) {
      state.filters[key] = new Set(allValues(key, state.rawData));
    }
    if (type === "delivered") state.filters.status = new Set(["Завершено"]);
    else if (type === "remaining") state.filters.status = new Set(["В работе"]);
    renderFilterOptions();
    applyFilters();
    saveState();
  }

  // ---------------------------------------------------------------------------
  // Таблица
  // ---------------------------------------------------------------------------
  function renderTable() {
    const defs = visibleColumnDefs();
    const head = $("main-table-head");
    if (head) {
      head.innerHTML =
        "<tr>" +
        defs
          .map((def) => {
            const active = state.sort.col === def.key;
            const arrow = active ? (state.sort.dir === 1 ? "▲" : "▼") : "";
            const ariaSort = active
              ? state.sort.dir === 1
                ? "ascending"
                : "descending"
              : "none";
            return `<th class="${def.class}" data-sort="${def.key}" tabindex="0" aria-sort="${ariaSort}">${esc(
              def.label,
            )} <span class="sort-icon" aria-hidden="true">${arrow}</span></th>`;
          })
          .join("") +
        "</tr>";
    }

    const body = $("table-body");
    if (!body) return;
    body.innerHTML = state.filteredData.length
      ? state.filteredData.map((r) => renderRow(r, defs)).join("")
      : `<tr><td colspan="${defs.length}" class="empty-state">Ничего не найдено. Измените фильтры.</td></tr>`;

    const count = $("table-count");
    if (count)
      count.textContent = `${state.filteredData.length} из ${state.rawData.length}`;
  }

  function renderRow(r, defs) {
    const conf = statusConf(r.status);
    const href = r.rvLink ? safeUrl(r.rvLink) : "";
    const dateHtml = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="raw-link">${esc(
          r.rvText || "Ссылка",
        )}</a>`
      : linkify(r.rvText || "—");
    const stage = stageLabel(r);

    const cells = defs.map((def) => {
      const label = `data-label="${esc(def.label)}"`;
      if (def.key === "obj") {
        return `<td ${label} class="${def.class}"><div class="cell-title">${esc(
          r.obj,
        )}</div>${stage ? `<div class="cell-sub">${esc(stage)}</div>` : ""}</td>`;
      }
      if (def.key === "status") {
        return `<td ${label} class="${def.class}"><span class="status-badge ${conf.badge}">${esc(
          r.status,
        )}</span></td>`;
      }
      if (def.key === "rvText") {
        return `<td ${label} class="${def.class}">${dateHtml}</td>`;
      }
      if (def.numeric) {
        const style = def.bold
          ? ' style="font-variant-numeric:tabular-nums;font-weight:600"'
          : ' style="font-variant-numeric:tabular-nums"';
        return `<td ${label} class="${def.class}"${style}>${showNum(r[def.key])}</td>`;
      }
      const cls =
        def.key === "source" || def.key === "damage" ? " cell-muted" : "";
      return `<td ${label} class="${def.class}${cls}">${esc(r[def.key])}</td>`;
    });
    return `<tr>${cells.join("")}</tr>`;
  }

  function sortTable(key) {
    if (state.sort.col === key) state.sort.dir *= -1;
    else {
      state.sort.col = key;
      state.sort.dir = 1;
    }
    applyFilters();
  }

  // ---------------------------------------------------------------------------
  // Дашборд
  // ---------------------------------------------------------------------------
  function renderDashboard(data) {
    const loading = $("dashboard-loading");
    if (loading) loading.style.display = "none";
    const content = $("dashboard-content");
    if (content) content.style.display = "block";

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentYear = today.getFullYear();
    if ($("kpi-year-label")) $("kpi-year-label").textContent = currentYear;
    if ($("kpi-remaining-year"))
      $("kpi-remaining-year").textContent = currentYear;

    const objects = new Set(data.map((r) => r.obj).filter(Boolean));
    if ($("kpi-objects")) $("kpi-objects").textContent = objects.size;

    const delivered = data.filter(
      (r) =>
        r.status === "Завершено" &&
        r.rvDate &&
        r.rvDate.getFullYear() === currentYear,
    );
    const deliveredArea = delivered.reduce((sum, r) => sum + r.areaBuild, 0);
    const deliveredObjs = new Set(delivered.map((r) => r.obj)).size;
    if ($("kpi-delivered-year"))
      $("kpi-delivered-year").textContent = fmt(deliveredArea);
    if ($("kpi-delivered-sub")) {
      $("kpi-delivered-sub").textContent = `${deliveredObjs} ${plural(
        deliveredObjs,
        ["объект", "объекта", "объектов"],
      )}`;
    }

    const remaining = data.filter(
      (r) =>
        r.status === "В работе" &&
        r.rvDate &&
        r.rvDate.getFullYear() === currentYear,
    );
    const remainingArea = remaining.reduce((sum, r) => sum + r.areaBuild, 0);
    const remainingObjs = new Set(remaining.map((r) => r.obj)).size;
    if ($("kpi-remaining")) $("kpi-remaining").textContent = fmt(remainingArea);
    if ($("kpi-remaining-sub")) {
      $("kpi-remaining-sub").textContent = `${remainingObjs} ${plural(
        remainingObjs,
        ["объект", "объекта", "объектов"],
      )}`;
    }

    const upcoming = data
      .filter((r) => r.status === "В работе" && r.rvDate && r.rvDate >= today)
      .sort((a, b) => a.rvDate - b.rvDate);

    if (upcoming.length) {
      const nearest = upcoming[0];
      const days = Math.round((nearest.rvDate - today) / 86400000);
      const when =
        days === 0
          ? "сегодня"
          : days === 1
            ? "завтра"
            : `через ${days} ${plural(days, ["день", "дня", "дней"])}`;
      if ($("kpi-nearest-name"))
        $("kpi-nearest-name").textContent = nearest.obj || "—";
      if ($("kpi-nearest-date")) {
        $("kpi-nearest-date").textContent = `${nearest.rvText || "—"} · ${
          stageLabel(nearest) || "этап"
        } · ${fmt(nearest.areaBuild)} м² · ${when}`;
      }
    } else {
      if ($("kpi-nearest-name")) $("kpi-nearest-name").textContent = "—";
      if ($("kpi-nearest-date"))
        $("kpi-nearest-date").textContent = "Нет запланированных";
    }

    const statusMap = new Map();
    data.forEach((r) => {
      const add = r.status === "Отказ" ? r.areaFreeze : r.areaBuild;
      statusMap.set(r.status, (statusMap.get(r.status) || 0) + add);
    });
    const statuses = [...statusMap.keys()]
      .filter((s) => statusMap.get(s) > 0)
      .sort((a, b) => {
        const ia = STATUS_ORDER.indexOf(a);
        const ib = STATUS_ORDER.indexOf(b);
        if (ia !== -1 || ib !== -1) {
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        }
        return String(a).localeCompare(String(b), "ru");
      });
    const maxStatusArea = Math.max(1, ...statuses.map((s) => statusMap.get(s)));
    const chartStatus = $("chart-status");
    if (chartStatus) {
      chartStatus.innerHTML = statuses.length
        ? statuses
            .map((status) => {
              const area = statusMap.get(status);
              const pct = (area / maxStatusArea) * 100;
              return `<div class="bar-item"><div class="bar-label">${esc(
                status,
              )}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${
                statusConf(status).color
              }"></div></div><div class="bar-value">${fmt(area)}</div></div>`;
            })
            .join("")
        : '<div class="empty-state">Нет данных</div>';
    }

    const yearMap = { Ранее: 0, Далее: 0 };
    data.forEach((r) => {
      if (!r.rvDate) return;
      const y = r.rvDate.getFullYear();
      if (y < 2024) yearMap["Ранее"] += r.areaBuild;
      else if (y <= currentYear) yearMap[y] = (yearMap[y] || 0) + r.areaBuild;
      else yearMap["Далее"] += r.areaBuild;
    });
    const sortedYears = Object.keys(yearMap).sort((a, b) => {
      if (a === "Ранее") return -1;
      if (b === "Ранее") return 1;
      if (a === "Далее") return 1;
      if (b === "Далее") return -1;
      return Number(a) - Number(b);
    });
    const maxYearArea = Math.max(1, ...sortedYears.map((y) => yearMap[y]));
    const chartYears = $("chart-years");
    if (chartYears) {
      chartYears.innerHTML = sortedYears
        .map((year) => {
          const area = yearMap[year];
          const pct = (area / maxYearArea) * 100;
          return `<div class="bar-item"><div class="bar-label">${esc(
            year,
          )}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--accent)"></div></div><div class="bar-value">${fmt(
            area,
          )}</div></div>`;
        })
        .join("");
    }

    initYearTable(data);

    const sortedByDate = data
      .filter((r) => r.rvDate)
      .sort((a, b) => a.rvDate - b.rvDate);
    const recent = sortedByDate
      .filter((r) => r.status === "Завершено" && r.rvDate <= today)
      .sort((a, b) => b.rvDate - a.rvDate)
      .slice(0, 5);

    const listHtml = (arr, type) =>
      arr
        .map((r) => {
          const href = r.rvLink ? safeUrl(r.rvLink) : "";
          const dateHtml = href
            ? `<a href="${esc(
                href,
              )}" target="_blank" rel="noopener noreferrer" class="delivery-link">${esc(
                r.rvText || "Ссылка",
              )}</a>`
            : esc(r.rvText || "—");
          return `<div class="delivery-item ${type}">
              <div class="delivery-date">${dateHtml}</div>
              <div class="delivery-obj">
                <div class="delivery-org">${esc(r.obj)}</div>
                <div class="delivery-stage">${esc(stageLabel(r) || "—")}</div>
              </div>
              <div class="delivery-area">${fmt(r.areaBuild)}</div>
            </div>`;
        })
        .join("");

    if ($("list-upcoming")) {
      $("list-upcoming").innerHTML = upcoming.length
        ? listHtml(upcoming.slice(0, 5), "future")
        : '<div class="empty-state">Нет данных</div>';
    }
    if ($("list-recent")) {
      $("list-recent").innerHTML = recent.length
        ? listHtml(recent, "past")
        : '<div class="empty-state">Нет данных</div>';
    }

    renderDataQuality(data);
  }

  // ---------------------------------------------------------------------------
  // Таблица по месяцам
  // ---------------------------------------------------------------------------
  const MONTHS_RU = [
    "январь",
    "февраль",
    "март",
    "апрель",
    "май",
    "июнь",
    "июль",
    "август",
    "сентябрь",
    "октябрь",
    "ноябрь",
    "декабрь",
  ];

  function renderYearTable(data, year) {
    const yearData = data.filter(
      (r) => r.rvDate && r.rvDate.getFullYear() === year,
    );
    const byObject = new Map();

    yearData.forEach((r) => {
      if (!byObject.has(r.obj)) {
        byObject.set(r.obj, {
          obj: r.obj,
          months: Array(12).fill(0),
          total: 0,
          items: [],
        });
      }
      const entry = byObject.get(r.obj);
      const month = r.rvDate.getMonth();
      entry.months[month] += r.areaBuild;
      entry.total += r.areaBuild;
      entry.items.push(r);
    });

    const rows = [...byObject.values()].sort((a, b) =>
      a.obj.localeCompare(b.obj, "ru"),
    );
    let html = `<tr><th class="text-left">Сдача площадей, ${year} год</th>${MONTHS_RU.map(
      (m) => `<th class="text-center">${m}</th>`,
    ).join("")}<th class="text-right">всего:</th></tr>`;

    rows.forEach((o) => {
      html += `<tr><td>${esc(o.obj)}</td>`;
      for (let m = 0; m < 12; m++) {
        const value = o.months[m];
        if (!value) {
          html += "<td></td>";
          continue;
        }
        const items = o.items.filter((i) => i.rvDate.getMonth() === m);
        const unique = [];
        const seen = new Set();
        items.forEach((i) => {
          const key = `${i.stage}|${i.rvText}|${i.rvLink}`;
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(i);
          }
        });
        const tooltip = unique
          .map((i) => {
            const href = i.rvLink ? safeUrl(i.rvLink) : "";
            const linkHtml = href
              ? ` <a href="${esc(
                  href,
                )}" target="_blank" rel="noopener noreferrer" class="tooltip-link">Ссылка</a>`
              : "";
            return `<div>${esc(stageLabel(i) || i.stage || "—")} | РВ: ${esc(
              i.rvText || "—",
            )}${linkHtml}</div>`;
          })
          .join("");
        const isDelivered = items.every((i) =>
          ["Завершено", "Утрачен", "Поврежден"].includes(i.status),
        );
        const cls = isDelivered ? "text-delivered" : "text-planned";
        const href = items[0].rvLink ? safeUrl(items[0].rvLink) : "";
        const content = href
          ? `<a href="${esc(
              href,
            )}" target="_blank" rel="noopener noreferrer" class="cell-link">${fmt(value)}</a>`
          : fmt(value);
        html += `<td><div class="tooltip-wrap" tabindex="0"><span class="${cls}">${content}</span><div class="tooltip-text">${tooltip}</div></div></td>`;
      }
      html += `<td class="text-right">${fmt(o.total)}</td></tr>`;
    });

    const table = $("year-table");
    if (table) {
      table.innerHTML = rows.length
        ? html
        : `<tr><td class="empty-state">Нет данных за ${year} год</td></tr>`;
    }
  }

  function initYearTable(data) {
    const years = new Set();
    data.forEach((r) => {
      if (r.rvDate) years.add(r.rvDate.getFullYear());
    });
    years.add(new Date().getFullYear());

    const select = $("year-select");
    if (!select) return;
    const sorted = [...years].sort((a, b) => b - a);
    const fallback = new Date().getFullYear();
    const year = years.has(state.selectedYear)
      ? state.selectedYear
      : years.has(fallback)
        ? fallback
        : sorted[0];

    select.innerHTML = sorted
      .map(
        (y) =>
          `<option value="${y}" ${y === year ? "selected" : ""}>${y} год</option>`,
      )
      .join("");
    renderYearTable(data, year);
  }

  // ---------------------------------------------------------------------------
  // Качество данных
  // ---------------------------------------------------------------------------
  function renderDataQuality(data) {
    const host = $("data-quality");
    if (!host) return;

    const items = [];
    const noDate = data.filter((r) => !r.rvDate).length;
    const zeroArea = data.filter((r) => r.areaBuild === 0).length;
    const badArea = data.filter((r) => r.badArea).length;
    const unknownStatus = data.filter((r) => !STATUS_CONF[r.status]).length;
    const idCounts = new Map();
    data.forEach((r) => {
      if (r.id && r.id !== "—")
        idCounts.set(r.id, (idCounts.get(r.id) || 0) + 1);
    });
    const duplicateIds = [...idCounts.values()].filter((c) => c > 1).length;
    const withoutCoords = [
      ...new Set(data.map((r) => r.obj).filter((o) => o && !coordsFor(o))),
    ];

    if (noDate)
      items.push(
        `${noDate} ${plural(noDate, ["строка", "строки", "строк"])} без даты РВ`,
      );
    if (zeroArea)
      items.push(
        `${zeroArea} ${plural(zeroArea, ["строка", "строки", "строк"])} с нулевой площадью стройки`,
      );
    if (badArea)
      items.push(
        `${badArea} ${plural(badArea, ["строка", "строки", "строк"])} с нечитаемой площадью`,
      );
    if (unknownStatus)
      items.push(
        `${unknownStatus} ${plural(unknownStatus, ["строка", "строки", "строк"])} с неизвестным статусом`,
      );
    if (duplicateIds) items.push(`${duplicateIds} повторяющихся ID`);
    if (withoutCoords.length) {
      items.push(
        `${withoutCoords.length} ${plural(withoutCoords.length, [
          "объект",
          "объекта",
          "объектов",
        ])} без координат на карте`,
      );
    }

    if (!items.length) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;
    host.innerHTML = `<div class="quality-title">Качество данных</div><ul class="quality-list">${items
      .map((i) => `<li>${esc(i)}</li>`)
      .join("")}</ul>`;
  }

  // ---------------------------------------------------------------------------
  // Карта
  // ---------------------------------------------------------------------------
  // Координаты площадок: файл «ВБИ Адреса площадок.xlsx» (листы «Адреса объектов»,
  // «БСКС», «Адреса объектов (ПТО)»; обновлён 29.09.2026).
  // Для 5 объектов координат в файле нет — оставлены городские (помечены ниже).
  const cityCoords = {
    "Электросталь": [55.74639, 38.417711],
    "Коледино": [55.386171, 37.583835],
    "Краснодар - 3": [45.05564, 39.067185],
    "Санкт-Петeрбург (Шушары) - 0": [59.796976, 30.452527],
    "Алексин (Тула)": [54.437607, 37.463473],
    "Невинномысск": [44.662811, 41.895601],
    "Волгоград (Авторемонтная)": [48.750677, 44.441552],
    "Котовск": [52.600805, 41.452585],
    "Сарапул": [56.481745, 53.691994],
    "Воронеж": [51.614243, 39.341544],
    "Владимир": [56.051602, 40.126095],
    "Рязань": [54.67858, 39.572295],
    "Самара": [53.390071, 50.332243],
    "Алексин (Тула) - 2": [54.440371, 37.464769],
    "Архангельск": [64.590071, 40.552306],
    "Благовещенск": [50.295939, 127.791289],
    "Бурятия (Улан-Удэ)": [51.761364, 107.448776],
    "Владивосток": [43.339111, 131.996753],
    "Владикавказ": [43.026541, 44.557658],
    "Екатеринбург": [56.729026, 60.576359],
    "Екатеринбург - 2": [56.726615, 60.572419],
    "Есипово": [56.108609, 37.085198],
    "Иваново Новоталицы": [56.997066, 40.85231],
    "Ингушетия (Магас)": [43.295793, 44.954482],
    "Иркутск (Ангарск)": [52.544358, 103.888249],
    "Коледино (доработка)": [55.386473, 37.584747],
    "Краснодар ПромПарк": [45.053159, 39.065039],
    "Красноярск": [56.18791, 92.978155],
    "Курск": [52.071634, 35.874111],
    "Кучино (Овчинки)": [55.420108, 37.689721],
    "Максимиха": [55.224401, 37.853757],
    "Новосаратовка": [59.857095, 30.521528],
    "Новосибирск": [55.018528, 82.534361],
    "Нижний Новгород": [56.204794, 43.879953],
    "Омск": [54.862278, 73.250236],
    "Оренбург": [51.86296, 55.183772],
    "Пенза": [53.266822, 44.788021],
    "Пермь": [57.89915, 56.20448],
    "Петрозаводск": [61.83802, 34.253724],
    "Ростов на Дону": [47.378061, 39.889191],
    "Рязань (производство)": [54.69051, 39.57768],
    "Санкт-Петербург (Красный бор)": [59.682958, 30.626177],
    "Санкт-Петербург (Шушары)": [59.796976, 30.452527],
    "Саратов": [51.61675, 45.855272],
    "Сенькино Секерино": [55.434284, 37.147903],
    "Симферополь": [45.011499, 34.184453],
    "Смоленск": [54.805902, 31.954295],
    "Софьино Краснопахорское": [55.449402, 37.318632],
    "Софьинское Раменское": [55.488226, 38.149492],
    "Сургут": [61.288497, 73.209988],
    "Тверь": [56.788146, 36.058515],
    "Тюмень": [57.099972, 65.389269],
    "Уфа": [54.717566, 55.764302],
    "Химки": [55.956217, 37.335997],
    "Челябинск": [55.219045, 61.111108],
    "Чита": [52.010938, 113.289675],
    "Южно-Сахалинск": [46.582785, 142.25605],
    "Юрга": [55.729765, 84.820016],
    "Ярославль": [57.544153, 39.899716],
    "Грузия (Тбилиси)": [41.610536, 44.901903],
    "Алматы": [43.327079, 76.80816],
    "Минск": [53.909439, 27.968931],
    "Астана (Нур-Султан)": [51.261958, 71.400396],
    "Ташкент": [41.191909, 69.172645],
    "Бишкек": [42.907119, 74.6656],
    "Минск - 2 (Фаниполь)": [53.756712, 27.392481],
    "Сенькино": [55.434284, 37.147903],
    "Алабушево": [56.099662, 37.155263],
    "Санкт-Петербург (Шушары) - 1": [59.796976, 30.452527],
    "Иркутск": [52.544358, 103.888249],
    "Грузия": [41.610536, 44.901903],
    "Алексин": [54.437607, 37.463473],
    "Алексин 2": [54.440371, 37.464769],
    "Волгоград": [48.750677, 44.441552],
    "Иваново": [56.997066, 40.85231],
    "Краснодар": [45.05564, 39.067185],
    "Магас": [43.295793, 44.954482],
    "Санкт-Петербург (Новосаратовка)": [59.857095, 30.521528],
    "Тбилиси": [41.610536, 44.901903],
    "Улан-Удэ": [51.761364, 107.448776],
    "Фаниполь": [53.756712, 27.392481],
    "Казань Зеленодольск": [55.7963, 49.1088], // в файле координаты не заполнены
    "Новоалтайск": [53.3918, 83.9363], // в файле координаты не заполнены
    "Махачкала": [42.9849, 47.5047], // объекта нет в файле
    "Хабаровск": [48.4827, 135.0838], // объекта нет в файле
    "Комсомольск-на-Амуре": [50.55, 137], // объекта нет в файле
  };

  const normName = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^0-9a-zа-я\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const coordIndex = new Map(
    Object.entries(cityCoords).map(([k, v]) => [normName(k), v]),
  );

  function coordsFor(obj) {
    const full = normName(obj);
    if (!full) return null;
    if (coordIndex.has(full)) return coordIndex.get(full);

    const parenthetical = String(obj).match(/\(([^)]+)\)/);
    if (parenthetical) {
      const inner = normName(parenthetical[1]);
      if (inner && coordIndex.has(inner)) return coordIndex.get(inner);
    }

    const base = normName(String(obj).replace(/\([^)]*\)/g, " "));
    if (base && coordIndex.has(base)) return coordIndex.get(base);

    const withoutNumber = full.replace(/\s+\d+$/, "");
    if (withoutNumber !== full && coordIndex.has(withoutNumber)) {
      return coordIndex.get(withoutNumber);
    }

    const words = full.split(" ").filter((w) => w.length >= 3);
    if (words.length) {
      let bestKey = null;
      let bestExtra = Infinity;
      for (const key of coordIndex.keys()) {
        const keyWords = new Set(key.split(" "));
        if (!words.every((w) => keyWords.has(w))) continue;
        const extra = keyWords.size - words.length;
        if (
          extra < bestExtra ||
          (extra === bestExtra && (!bestKey || key.length < bestKey.length))
        ) {
          bestKey = key;
          bestExtra = extra;
        }
      }
      if (bestKey) return coordIndex.get(bestKey);
    }

    let prefixKey = null;
    for (const key of coordIndex.keys()) {
      if (key.length < 4) continue;
      if (full.startsWith(key) || key.startsWith(full)) {
        if (!prefixKey || key.length < prefixKey.length) prefixKey = key;
      }
    }
    return prefixKey ? coordIndex.get(prefixKey) : null;
  }

  let mapsPromise = null;
  function loadYandexMaps(apiKey) {
    if (mapsPromise) return mapsPromise;
    mapsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://api-maps.yandex.ru/2.1/?lang=ru_RU&apikey=${encodeURIComponent(apiKey)}`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        mapsPromise = null;
        script.remove();
        reject(new Error("не удалось загрузить API (сеть или блокировка)"));
      };
      document.head.appendChild(script);
    });
    return mapsPromise;
  }

  function watchMapTiles() {
    let checks = 0;
    const timer = setInterval(() => {
      const mapEl = $("map");
      if (!mapEl || !state.map) {
        clearInterval(timer);
        return;
      }
      const tiles = mapEl.querySelectorAll(
        ".ymaps-2-1-79-tile img, .ymaps-2-1-79-tile canvas",
      ).length;
      if (tiles > 0) {
        clearInterval(timer);
        hideMapNotice();
        return;
      }
      checks += 1;
      if (checks === 5) {
        showMapNotice(
          "Карта инициализирована, но тайлы не загрузились. Проверьте API-ключ: тип сервиса " +
            "(должен быть «JavaScript API»), активацию (до 15 минут) и ограничения по домену. " +
            "Счётчик загрузок: " +
            `${mapUsageToday().count}/${CONFIG.mapsDailyLimit}.`,
        );
      }
      if (checks >= 10) clearInterval(timer);
    }, 2000);
  }

  function showMapNotice(html) {
    const notice = $("map-notice");
    if (!notice) return;
    notice.hidden = false;
    notice.innerHTML = `<div class="map-notice-inner">${html}</div>`;
  }
  function hideMapNotice() {
    const notice = $("map-notice");
    if (notice) notice.hidden = true;
  }

  const MAP_USAGE_KEY = "bos_map_usage";

  function mapUsageToday() {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const raw = localStorage.getItem(MAP_USAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (!data || data.date !== today || typeof data.count !== "number") {
        return { date: today, count: 0 };
      }
      return data;
    } catch {
      return { date: today, count: 0 };
    }
  }

  function bumpMapUsage() {
    const usage = mapUsageToday();
    usage.count += 1;
    try {
      localStorage.setItem(MAP_USAGE_KEY, JSON.stringify(usage));
    } catch {
      /* localStorage недоступен */
    }
    return usage;
  }

  function ensureMap() {
    if (!CONFIG.mapsApiKey) {
      showMapNotice(
        "Карта недоступна: не задан API-ключ Яндекс.Карт. Получите ключ в " +
          '<a href="https://developer.tech.yandex.ru/services/" target="_blank" rel="noopener noreferrer">кабинете разработчика</a> ' +
          "и укажите его в <code>CONFIG.mapsApiKey</code> в файле <code>app.js</code>.",
      );
      updateMap();
      return;
    }
    if (state.map) {
      try {
        state.map.container.fitToViewport();
      } catch {
        /* размер контейнера ещё не пересчитан */
      }
      updateMap();
      return;
    }
    if (state.mapLoading) return;

    const usage = mapUsageToday();
    if (!state.mapForceLoad && usage.count >= CONFIG.mapsDailyLimit) {
      showMapNotice(
        `Дневной лимит загрузок карты исчерпан: ${usage.count}/${CONFIG.mapsDailyLimit}. ` +
          "Счётчик локальный (для этого браузера) и обнуляется в полночь. " +
          '<button type="button" class="btn btn-secondary map-force" data-map-force="1">Загрузить всё равно</button>',
      );
      return;
    }
    state.mapForceLoad = false;
    bumpMapUsage();

    state.mapLoading = loadYandexMaps(CONFIG.mapsApiKey)
      .then(
        () =>
          new Promise((resolve, reject) => {
            if (typeof ymaps === "undefined") {
              reject(new Error("API Яндекс.Карт не инициализировался"));
              return;
            }
            const timer = setTimeout(
              () => reject(new Error("таймаут инициализации карты")),
              15000,
            );
            ymaps.ready(() => {
              clearTimeout(timer);
              try {
                state.map = new ymaps.Map("map", {
                  center: [61.524, 90.318],
                  zoom: 3,
                  controls: ["zoomControl", "fullscreenControl"],
                });
                state.markersLayer = new ymaps.GeoObjectCollection();
                state.map.geoObjects.add(state.markersLayer);
                hideMapNotice();
                updateMap();
                watchMapTiles();
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          }),
      )
      .catch((e) => {
        state.mapLoading = null;
        showMapNotice(`Не удалось загрузить карту: ${esc(e.message)}`);
      });
  }

  function getPieChartGradient(statusAreas) {
    const total = Object.values(statusAreas).reduce((a, b) => a + b, 0);
    if (!total) return "#ccc";
    let angle = 0;
    const parts = [];
    Object.entries(statusAreas)
      .sort((a, b) => b[1] - a[1])
      .forEach(([status, area]) => {
        const span = (area / total) * 360;
        parts.push(`${statusConf(status).hex} ${angle}deg ${angle + span}deg`);
        angle += span;
      });
    return `conic-gradient(${parts.join(", ")})`;
  }

  function updateMap() {
    const grouped = new Map();
    const missing = new Set();

    state.rawData.forEach((r) => {
      const coords = coordsFor(r.obj);
      if (!coords) {
        if (r.obj) missing.add(r.obj);
        return;
      }
      if (!grouped.has(r.obj)) {
        grouped.set(r.obj, { coords, area: 0, stages: 0, statusAreas: {} });
      }
      const g = grouped.get(r.obj);
      g.area += r.areaBuild;
      g.stages++;
      const st = r.status || "Не указан";
      g.statusAreas[st] = (g.statusAreas[st] || 0) + (r.areaBuild || 1);
    });

    if ($("map-summary")) {
      const usage = mapUsageToday();
      $("map-summary").textContent = `На карте: ${grouped.size} ${plural(
        grouped.size,
        ["объект", "объекта", "объектов"],
      )} · загрузок карты сегодня: ${usage.count}/${CONFIG.mapsDailyLimit}`;
    }
    if ($("map-missing")) {
      $("map-missing").textContent = missing.size
        ? `Без координат: ${missing.size} — ${[...missing].slice(0, 6).join(", ")}${
            missing.size > 6 ? "…" : ""
          }`
        : "";
    }

    if (!state.map || !state.markersLayer) return;
    state.markersLayer.removeAll();

    grouped.forEach((d, city) => {
      const gradient = getPieChartGradient(d.statusAreas);
      const layout = ymaps.templateLayoutFactory.createClass(
        `<div class="map-pie" style="background:${gradient}"></div>`,
      );
      const placemark = new ymaps.Placemark(
        d.coords,
        {
          hintContent: esc(city),
          balloonContentHeader: `<b class="map-balloon-title">${esc(city)}</b>`,
          balloonContentBody: `
        <div class="map-balloon">
          Этапов: ${d.stages}<br>
          Площадь: ${fmt(d.area)} м²<br>
          <a href="#table?obj=${encodeURIComponent(city)}">Показать в таблице</a>
        </div>`,
        },
        {
          iconLayout: "default#imageWithContent",
          iconImageHref:
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          iconImageSize: [24, 24],
          iconImageOffset: [-12, -12],
          iconContentLayout: layout,
        },
      );
      state.markersLayer.add(placemark);
    });
  }

  // ---------------------------------------------------------------------------
  // Сравнение
  // ---------------------------------------------------------------------------
  const COMPARE_FIELDS = [
    { key: "этап", label: "Этап", excelPrefix: "Наименование этапа" },
    { key: "статус", label: "Статус площади", excelPrefix: "Статус площади" },
    {
      key: "общая площадь",
      label: "Общая площадь",
      excelPrefix: "Общая площадь",
    },
    {
      key: "площадь строительства",
      label: "Площадь объекта строительства",
      excelPrefix: "Площадь объекта строительства",
    },
    {
      key: "площадь блоков мезонина",
      label: "Площадь блоков мезонина",
      excelPrefix: "Площадь блоков мезонина",
    },
    {
      key: "площадь оперзоны",
      label: "Площадь оперзоны",
      excelPrefix: "Площадь оперзоны",
    },
    {
      key: "площадь заморозки",
      label: "Площадь заморозки",
      excelPrefix: "Площадь заморозки",
    },
    {
      key: "статус площадки",
      label: "Статус площадки",
      excelPrefix: "Статус площадки",
    },
    { key: "РВ", label: "Дата получения РВ", excelPrefix: "Дата получения РВ" },
    {
      key: "категория",
      label: "Категория объекта",
      excelPrefix: "Категория объекта",
      exact: true,
    },
    {
      key: "источник",
      label: "Источник данных",
      excelPrefix: "Источник данных площади",
    },
    {
      key: "повреждения",
      label: "Повреждение блока",
      excelPrefix: "Повреждение блока",
      exact: true,
    },
  ];
  const COMPARE_ALIASES = {
    этап: ["этап", "наименование этапа"],
    статус: ["статус", "статус площади"],
    категория: ["категория", "категория объекта"],
    источник: ["источник данных площади", "источник"],
    повреждения: ["повреждения", "повреждение блока"],
    РВ: ["РВ", "дата получения РВ"],
  };

  function pickHeader(row, names) {
    for (const name of names) {
      if (row[name] !== undefined) return row[name];
      const key = Object.keys(row).find(
        (k) => k.toLowerCase() === String(name).toLowerCase(),
      );
      if (key !== undefined) return row[key];
    }
    return undefined;
  }

  function findLatestSuffix(headers) {
    const matches = [
      ...headers.join(" | ").matchAll(/\((\d{2})\.(\d{2})\.(\d{4})\)/g),
    ];
    if (!matches.length) return null;
    return matches
      .map((m) => ({
        full: m[0],
        ts: new Date(`${m[3]}-${m[2]}-${m[1]}`).getTime(),
      }))
      .sort((a, b) => b.ts - a.ts)[0].full;
  }

  function buildExcelMapping(headers) {
    const suffix = findLatestSuffix(headers);
    const findCol = (prefix) => {
      const p = prefix.toLowerCase();
      const starts = headers.filter((h) =>
        String(h).toLowerCase().startsWith(p),
      );
      if (!starts.length) return null;
      if (suffix) {
        const withSuffix = starts.find((h) => h.includes(suffix));
        if (withSuffix) return withSuffix;
      }
      return starts[0];
    };
    const exact = (name) =>
      headers.find((h) => String(h).toLowerCase() === name.toLowerCase()) ||
      null;

    const mapping = {
      id: exact("id"),
      ФО: exact("ФО"),
      объект: exact("объект"),
    };
    for (const field of COMPARE_FIELDS) {
      const candidates = [
        field.excelPrefix,
        field.key,
        ...(COMPARE_ALIASES[field.key] || []),
      ];
      let column = null;
      for (const candidate of candidates) {
        column =
          field.exact || candidate === field.key
            ? exact(candidate)
            : findCol(candidate);
        if (column) break;
      }
      mapping[field.key] = column;
    }
    return mapping;
  }

  function inspectSource(data) {
    if (!data) {
      return {
        ok: false,
        missingRequired: ["данные не загружены"],
        missingOptional: [],
        fields: [],
        mapping: null,
      };
    }
    if (data.type === "google") {
      const headers = data.headers.map((h) => String(h).toLowerCase());
      const has = (names) =>
        names.some((n) => headers.includes(n.toLowerCase()));
      const missingRequired = [];
      if (!has(["ФО"])) missingRequired.push("ФО");
      if (!has(["объект"])) missingRequired.push("объект");
      if (!has(["этап", "наименование этапа"])) missingRequired.push("этап");
      const fields = COMPARE_FIELDS.filter((f) =>
        has([f.key, ...(COMPARE_ALIASES[f.key] || [])]),
      );
      return {
        ok: missingRequired.length === 0,
        missingRequired,
        missingOptional: COMPARE_FIELDS.filter((f) => !fields.includes(f)).map(
          (f) => f.label,
        ),
        fields: fields.map((f) => f.key),
        mapping: null,
      };
    }
    const mapping = buildExcelMapping(data.headers);
    const missingRequired = ["ФО", "объект", "этап"].filter((k) => !mapping[k]);
    const fields = COMPARE_FIELDS.filter((f) => mapping[f.key]);
    return {
      ok: missingRequired.length === 0,
      missingRequired,
      missingOptional: COMPARE_FIELDS.filter((f) => !mapping[f.key]).map(
        (f) => f.label,
      ),
      fields: fields.map((f) => f.key),
      mapping,
    };
  }

  function normalizeValueComp(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) {
      return `${String(v.getDate()).padStart(2, "0")}.${String(
        v.getMonth() + 1,
      ).padStart(2, "0")}.${v.getFullYear()}`;
    }
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const s = v.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
      const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (d) return `${d[3]}.${d[2]}.${d[1]}`;
      const gviz = s.match(/^Date\((\d+),(\d+),(\d+)/);
      if (gviz) {
        return `${String(gviz[3]).padStart(2, "0")}.${String(
          +gviz[2] + 1,
        ).padStart(2, "0")}.${gviz[1]}`;
      }
      return s;
    }
    return String(v);
  }

  function normalizeIdComp(v) {
    if (v == null) return "нет ID";
    if (typeof v === "number") {
      return Number.isInteger(v) ? String(v) : String(Math.trunc(v));
    }
    const s = String(v).trim();
    if (s === "" || s.toLowerCase() === "нет id") return "нет ID";
    return s;
  }

  function normalizeObjectComp(v) {
    if (v == null) return "";
    return String(v)
      .trim()
      .replace(/^БВС\s+/i, "")
      .replace(/\s+БВС$/i, "")
      .toLowerCase();
  }

  function normalizeStageComp(v) {
    if (v == null) return "";
    return String(v)
      .trim()
      .replace(/[()]/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function valuesEqualComp(a, b) {
    const na = parseNumStrict(a);
    const nb = parseNumStrict(b);
    const aIsNum = na !== null && !Number.isNaN(na);
    const bIsNum = nb !== null && !Number.isNaN(nb);
    if (aIsNum && bIsNum) return Math.abs(na - nb) < 0.01;
    const norm = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v).trim();
      return s === "-" || s === "—" ? "" : s;
    };
    return norm(a) === norm(b);
  }

  function extractNormalizedRowsComp(data) {
    const inspect = data.inspect || (data.inspect = inspectSource(data));
    const mapping = inspect.mapping;
    const valueOf = (row, field) => {
      if (data.type === "google") {
        return normalizeValueComp(
          pickHeader(row, [field.key, ...(COMPARE_ALIASES[field.key] || [])]),
        );
      }
      return normalizeValueComp(row[mapping[field.key]]);
    };
    const baseValue = (row, key, aliases) => {
      if (data.type === "google")
        return normalizeValueComp(pickHeader(row, aliases));
      return normalizeValueComp(row[mapping[key]]);
    };

    return data.rows.map((r) => {
      const row = {
        __row: r.__row,
        id: normalizeIdComp(
          data.type === "google" ? pickHeader(r, ["id"]) : r[mapping["id"]],
        ),
        ФО: baseValue(r, "ФО", ["ФО"]),
        объект: baseValue(r, "объект", ["объект"]),
        этап: baseValue(r, "этап", ["этап", "наименование этапа"]),
      };
      row.объект_norm = normalizeObjectComp(row["объект"]);
      row.этап_norm = normalizeStageComp(row["этап"]);
      for (const field of COMPARE_FIELDS) row[field.key] = valueOf(r, field);
      return row;
    });
  }

  function runComparisonComp() {
    const left = state.compare.left;
    const right = state.compare.right;
    if (!left || !right) return;

    if (!left.inspect || !right.inspect) {
      left.inspect = inspectSource(left);
      right.inspect = inspectSource(right);
    }
    if (!left.inspect.ok || !right.inspect.ok) {
      const missing = [
        ...new Set([
          ...left.inspect.missingRequired,
          ...right.inspect.missingRequired,
        ]),
      ];
      showToast(
        "Не хватает обязательных колонок: " + missing.join(", "),
        "error",
        8000,
      );
      return;
    }

    const fields = COMPARE_FIELDS.filter(
      (f) =>
        left.inspect.fields.includes(f.key) &&
        right.inspect.fields.includes(f.key),
    );
    const skipped = COMPARE_FIELDS.filter((f) => !fields.includes(f)).map(
      (f) => f.label,
    );

    const gRows = extractNormalizedRowsComp(left);
    const xRows = extractNormalizedRowsComp(right);

    const isNoId = (id) => !id || id === "нет ID";
    const pkey = (r) =>
      isNoId(r.id) ? `noid|${r["ФО"] || ""}|${r.объект_norm}` : `id|${r.id}`;
    const skey = (r) => `${r.этап_norm}|${normalizeStageComp(r["категория"])}`;

    const gGroups = new Map();
    const xGroups = new Map();
    gRows.forEach((r) => {
      if (!gGroups.has(pkey(r))) gGroups.set(pkey(r), []);
      gGroups.get(pkey(r)).push(r);
    });
    xRows.forEach((r) => {
      if (!xGroups.has(pkey(r))) xGroups.set(pkey(r), []);
      xGroups.get(pkey(r)).push(r);
    });

    const pairs = [];
    const onlyG = [];
    const onlyX = [];
    const allKeys = new Set([...gGroups.keys(), ...xGroups.keys()]);

    for (const key of allKeys) {
      const g = gGroups.get(key) || [];
      const x = xGroups.get(key) || [];
      const usedG = new Set();
      const usedX = new Set();

      for (let i = 0; i < g.length; i++) {
        for (let j = 0; j < x.length; j++) {
          if (usedX.has(j)) continue;
          if (skey(g[i]) === skey(x[j])) {
            pairs.push([g[i], x[j], "exact"]);
            usedG.add(i);
            usedX.add(j);
            break;
          }
        }
      }
      const restG = g.filter((_, i) => !usedG.has(i));
      const restX = x.filter((_, j) => !usedX.has(j));
      const minLen = Math.min(restG.length, restX.length);
      for (let i = 0; i < minLen; i++)
        pairs.push([restG[i], restX[i], "fuzzy"]);
      onlyG.push(...restG.slice(minLen));
      onlyX.push(...restX.slice(minLen));
    }

    const changes = [];
    for (const [gr, xr, match] of pairs) {
      for (const field of fields) {
        const oldValue = gr[field.key];
        const newValue = xr[field.key];
        const differs =
          field.key === "этап"
            ? normalizeStageComp(oldValue) !== normalizeStageComp(newValue)
            : !valuesEqualComp(oldValue, newValue);
        if (!differs) continue;
        const change = {
          id: gr.id,
          fo: gr["ФО"],
          obj: gr["объект"],
          stage_old: gr["этап"],
          stage_new: xr["этап"],
          field: field.label,
          old: oldValue,
          new: newValue,
          match,
        };
        change.__search =
          `${change.id} ${change.fo} ${change.obj} ${change.stage_old} ${
            change.stage_new
          } ${change.field} ${change.old ?? ""} ${change.new ?? ""}`.toLowerCase();
        changes.push(change);
      }
    }

    renderCompareResults({
      gRows,
      xRows,
      changes,
      fuzzy: pairs.filter((p) => p[2] === "fuzzy"),
      onlyG,
      onlyX,
      skipped,
    });
  }

  function compareModeLabels() {
    const google = state.compare.mode === "g_vs_x";
    return {
      left: google ? "Google" : "Excel (старый)",
      right: google ? "Excel" : "Excel (новый)",
    };
  }

  const rowSearch = (r) =>
    `${r.id} ${r["ФО"]} ${r["объект"]} ${r["этап"]} ${r["статус"]} ${r["общая площадь"] ?? ""}`.toLowerCase();

  function changeRowsHtml(list) {
    let prevKey = null;
    return list
      .map((r) => {
        const key = `${r.id}|${r.obj}|${r.stage_new}`;
        const grouped = key === prevKey;
        prevKey = key;
        const cls = grouped ? "muted-text" : "";
        let stageHtml =
          r.field === "Этап"
            ? `<span class="old-val">${esc(r.stage_old ?? "")}</span> → <span class="new-val">${esc(
                r.stage_new ?? "",
              )}</span>`
            : esc(r.stage_new || r.stage_old || "");
        if (grouped && r.field !== "Этап") stageHtml = "";
        const badge =
          r.match === "fuzzy"
            ? ' <span class="match-badge" title="Сопоставлено приблизительно">≈</span>'
            : "";
        const oldVal =
          r.old === null || r.old === undefined || r.old === "" ? "—" : r.old;
        const newVal =
          r.new === null || r.new === undefined || r.new === "" ? "—" : r.new;
        return `<tr><td class="${cls}">${esc(r.id)}</td><td class="${cls}">${esc(
          r.fo,
        )}</td><td class="${cls}">${esc(r.obj)}${badge}</td><td class="${cls}">${stageHtml}</td><td><strong>${esc(
          r.field,
        )}</strong></td><td><span class="old-val">${esc(oldVal)}</span></td><td><span class="new-val">${esc(
          newVal,
        )}</span></td></tr>`;
      })
      .join("");
  }

  function renderCompareResults(d) {
    state.compare.result = d;
    $("compare-upload-screen").style.display = "none";
    $("compare-report-screen").style.display = "block";

    const { left, right } = compareModeLabels();
    const meta = [
      `Режим: ${left} ↔ ${right}`,
      `строк: ${d.gRows.length} / ${d.xRows.length}`,
    ];
    if (d.skipped.length) meta.push(`не сравнивались: ${d.skipped.join(", ")}`);
    $("compare-meta").textContent = meta.join(" · ");

    const tabs = [
      { key: "changes", label: "Изменения", count: d.changes.length },
      { key: "only_x", label: `Только в ${right}`, count: d.onlyX.length },
      { key: "only_g", label: `Только в ${left}`, count: d.onlyG.length },
    ];
    if (d.fuzzy.length) {
      tabs.push({
        key: "fuzzy",
        label: "Приблизительные пары",
        count: d.fuzzy.length,
      });
    }

    const headers = {
      changes: ["ID", "ФО", "Объект", "Этап", "Поле", "Было", "Стало"],
      only_x: ["ID", "ФО", "Объект", "Этап", "Статус", "Общая", "Строит."],
      only_g: ["ID", "ФО", "Объект", "Этап", "Статус", "Общая", "Строит."],
      fuzzy: [
        "ID",
        "ФО",
        "Объект",
        "Этап слева",
        "Этап справа",
        "Статус слева",
        "Статус справа",
      ],
    };

    let html = `<div class="summary">
      <div class="stat"><div class="stat-label">${esc(left)}</div><div class="stat-value">${
        d.gRows.length
      }</div><div class="stat-detail">строк</div></div>
      <div class="stat"><div class="stat-label">${esc(right)}</div><div class="stat-value">${
        d.xRows.length
      }</div><div class="stat-detail">строк</div></div>
      <div class="stat yellow"><div class="stat-label">Изменений</div><div class="stat-value">${
        d.changes.length
      }</div><div class="stat-detail">${plural(d.changes.length, [
        "ячейка",
        "ячейки",
        "ячеек",
      ])}</div></div>
      <div class="stat blue"><div class="stat-label">Приблизительных пар</div><div class="stat-value">${
        d.fuzzy.length
      }</div><div class="stat-detail">сопоставлено по порядку</div></div>
      <div class="stat green"><div class="stat-label">Только в ${esc(
        right,
      )}</div><div class="stat-value">${d.onlyX.length}</div><div class="stat-detail">добавлено</div></div>
      <div class="stat red"><div class="stat-label">Только в ${esc(
        left,
      )}</div><div class="stat-value">${d.onlyG.length}</div><div class="stat-detail">удалено</div></div>
    </div>
    <div class="tabs" id="compare-tabs" role="tablist">${tabs
      .map(
        (t, i) =>
          `<button class="tab ${i === 0 ? "active" : ""}" role="tab" aria-selected="${
            i === 0
          }" data-tab="${t.key}">${esc(t.label)}<span class="tab-count">${t.count}</span></button>`,
      )
      .join("")}</div>`;

    tabs.forEach((t, i) => {
      html += `<div class="panel ${i === 0 ? "" : "hidden"}" id="panel-${t.key}" role="tabpanel">
        <div class="toolbar">
          <input class="filter" id="f-${t.key}" placeholder="Поиск..." aria-label="Поиск по таблице">
          <span class="row-count" id="c-${t.key}"></span>
        </div>
        <div class="table-wrap"><table id="t-${t.key}"><thead><tr>${headers[
          t.key
        ]
          .map((h) => `<th>${esc(h)}</th>`)
          .join("")}</tr></thead><tbody></tbody></table></div>
      </div>`;
    });

    $("compare-content").innerHTML = html;
    renderCompareRows();
  }

  function renderCompareRows() {
    const d = state.compare.result;
    if (!d) return;
    const query = (panel) =>
      (($("f-" + panel) || {}).value || "").trim().toLowerCase();

    const changes = d.changes.filter(
      (r) => !query("changes") || r.__search.includes(query("changes")),
    );
    const tChanges = $("t-changes");
    if (tChanges) {
      tChanges.querySelector("tbody").innerHTML =
        changeRowsHtml(changes) ||
        '<tr><td colspan="7" class="empty-state">Изменений не найдено</td></tr>';
      $("c-changes").textContent = `${changes.length} из ${d.changes.length}`;
    }

    const fill = (key, rows, render) => {
      const table = $("t-" + key);
      if (!table) return;
      const q = query(key);
      const list = q
        ? rows.filter((r) =>
            (render.search ? render.search(r) : "").includes(q),
          )
        : rows;
      table.querySelector("tbody").innerHTML =
        list.map((r) => render.row(r)).join("") ||
        `<tr><td colspan="${render.cols}" class="empty-state">Нет строк</td></tr>`;
      $("c-" + key).textContent = `${list.length} из ${rows.length}`;
    };

    const onlyRow = (r) =>
      `<tr><td>${esc(r.id)}</td><td>${esc(r["ФО"])}</td><td>${esc(r["объект"])}</td><td>${esc(
        r["этап"],
      )}</td><td>${esc(r["статус"])}</td><td>${fmt(r["общая площадь"])}</td><td>${fmt(
        r["площадь строительства"],
      )}</td></tr>`;

    fill("only_x", d.onlyX, { cols: 7, row: onlyRow, search: rowSearch });
    fill("only_g", d.onlyG, { cols: 7, row: onlyRow, search: rowSearch });

    if (d.fuzzy.length) {
      fill("fuzzy", d.fuzzy, {
        cols: 7,
        row: ([g, x]) =>
          `<tr><td>${esc(g.id)}</td><td>${esc(g["ФО"])}</td><td>${esc(g["объект"])}</td><td><span class="old-val">${esc(
            g["этап"],
          )}</span></td><td><span class="new-val">${esc(x["этап"])}</span></td><td>${esc(
            g["статус"],
          )}</td><td>${esc(x["статус"])}</td></tr>`,
        search: ([g, x]) => rowSearch(g) + " " + rowSearch(x),
      });
    }
  }

  function setCompareStatus(id, text, type = "muted") {
    const el = $(id);
    if (!el) return;
    el.style.color =
      type === "error"
        ? "var(--danger)"
        : type === "warning"
          ? "var(--warning)"
          : type === "success"
            ? "var(--success)"
            : "var(--text-muted)";
    el.textContent = text;
  }

  function applyCompareSource(side, data, statusId) {
    data.inspect = inspectSource(data);
    if (side === "left") state.compare.left = data;
    else state.compare.right = data;

    const inspect = data.inspect;
    if (!inspect.ok) {
      setCompareStatus(
        statusId,
        `✕ Не хватает колонок: ${inspect.missingRequired.join(", ")}`,
        "error",
      );
    } else if (inspect.missingOptional.length) {
      setCompareStatus(
        statusId,
        `✓ строк: ${data.rows.length}. Не сравниваются: ${inspect.missingOptional.join(", ")}`,
        "warning",
      );
    } else {
      setCompareStatus(statusId, `✓ строк: ${data.rows.length}`, "success");
    }
    updateCompareBtn();
  }

  function updateCompareBtn() {
    const btn = $("btn-run-comp");
    if (!btn) return;
    const ok =
      state.compare.left &&
      state.compare.right &&
      state.compare.left.inspect &&
      state.compare.right.inspect &&
      state.compare.left.inspect.ok &&
      state.compare.right.inspect.ok;
    btn.disabled = !ok;
  }

  async function readXlsxComp(file, preferredSheets) {
    if (typeof ExcelJS === "undefined")
      throw new Error("библиотека ExcelJS не загружена");
    const buffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let sheet = null;
    for (const name of preferredSheets) {
      sheet = workbook.getWorksheet(name);
      if (sheet) break;
    }
    if (!sheet) sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("в файле нет листов");

    const headers = [];
    const headerRow = sheet.getRow(1);
    const lastCol = Math.max(sheet.columnCount || 0, 1);
    for (let col = 1; col <= lastCol; col++) {
      const cell = headerRow.getCell(col);
      let value = cell ? cell.value : null;
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if (value.richText) value = value.richText.map((r) => r.text).join("");
        else if (value.text !== undefined) value = value.text;
        else if (value.result !== undefined) value = value.result;
      }
      headers[col] =
        value == null ? "" : String(value).replace(/\s+/g, " ").trim();
    }

    const rows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = { __row: rowNumber };
      let hasValue = false;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        let value = cell.value;
        let link = null;
        if (value && typeof value === "object" && !(value instanceof Date)) {
          if (value.hyperlink) link = value.hyperlink;
          if (value.richText)
            value = value.richText.map((r) => r.text).join("");
          else if (value.text !== undefined) value = value.text;
          else if (value.result !== undefined) value = value.result;
        } else if (value instanceof Date) {
          value = `${String(value.getDate()).padStart(2, "0")}.${String(
            value.getMonth() + 1,
          ).padStart(2, "0")}.${value.getFullYear()}`;
        }
        const header = headers[col];
        if (header) {
          obj[header] = value;
          if (link) obj[header + "_link"] = link;
          if (value !== null && value !== undefined && value !== "")
            hasValue = true;
        }
      });
      if (hasValue) rows.push(obj);
    });

    return { headers: headers.filter(Boolean), rows };
  }

  // ---------------------------------------------------------------------------
  // Экспорт
  // ---------------------------------------------------------------------------
  function downloadBlob(buffer, filename) {
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const fileStamp = () =>
    new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");

  function addSheet(workbook, name, headers, widths) {
    const sheet = workbook.addWorksheet(name);
    const headerRow = sheet.addRow(headers);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.height = 20;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF0F172A" },
      };
      cell.alignment = { vertical: "middle" };
    });
    if (widths) sheet.columns = widths.map((width) => ({ width }));
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: headers.length },
    };
    return sheet;
  }

  async function exportSelection() {
    if (!state.filteredData.length) {
      showToast("Нет данных для экспорта", "warning");
      return;
    }
    if (typeof ExcelJS === "undefined") {
      showToast(
        "Библиотека ExcelJS не загрузилась (проверьте сеть)",
        "error",
        7000,
      );
      return;
    }
    try {
      const defs = visibleColumnDefs();
      const workbook = new ExcelJS.Workbook();
      const sheet = addSheet(
        workbook,
        "Выборка",
        defs.map((d) => d.label),
        defs.map((d) => d.width || 16),
      );
      state.filteredData.forEach((r) => {
        sheet.addRow(
          defs.map((def) => {
            if (def.key === "obj") {
              const stage = stageLabel(r);
              return stage ? `${r.obj} / ${stage}` : r.obj;
            }
            return r[def.key] ?? "";
          }),
        );
      });
      defs.forEach((def, index) => {
        if (def.numeric) sheet.getColumn(index + 1).numFmt = "# ##0.00";
      });
      downloadBlob(
        await workbook.xlsx.writeBuffer(),
        `Выборка_${fileStamp()}.xlsx`,
      );
      showToast("Экспорт готов", "success", 3000);
    } catch (e) {
      console.error(e);
      showToast("Не удалось сформировать Excel: " + e.message, "error", 7000);
    }
  }

  async function downloadCompareXlsx() {
    const d = state.compare.result;
    if (!d) return;
    if (typeof ExcelJS === "undefined") {
      showToast(
        "Библиотека ExcelJS не загрузилась (проверьте сеть)",
        "error",
        7000,
      );
      return;
    }
    const { left, right } = compareModeLabels();
    try {
      const workbook = new ExcelJS.Workbook();
      const summary = addSheet(
        workbook,
        "Сводка",
        ["Параметр", "Значение"],
        [30, 40],
      );
      [
        ["Режим сравнения", `${left} ↔ ${right}`],
        ["Строк слева", d.gRows.length],
        ["Строк справа", d.xRows.length],
        ["Изменений", d.changes.length],
        ["Приблизительных пар", d.fuzzy.length],
        [`Только в ${right}`, d.onlyX.length],
        [`Только в ${left}`, d.onlyG.length],
        ["Не сравнивались поля", d.skipped.join(", ") || "—"],
      ].forEach((row) => summary.addRow(row));

      const changes = addSheet(
        workbook,
        "Изменения",
        [
          "ID",
          "ФО",
          "Объект",
          "Этап",
          "Поле",
          "Было",
          "Стало",
          "Сопоставление",
        ],
        [12, 15, 20, 30, 24, 20, 20, 16],
      );
      d.changes.forEach((change) => {
        const stageDisplay =
          change.field === "Этап"
            ? `${change.old ?? ""} → ${change.new ?? ""}`
            : change.stage_new || change.stage_old || "";
        const row = changes.addRow([
          change.id,
          change.fo,
          change.obj,
          stageDisplay,
          change.field,
          change.old ?? "",
          change.new ?? "",
          change.match === "fuzzy" ? "приблизительно" : "точно",
        ]);
        row.getCell(6).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFEF2F2" },
        };
        row.getCell(7).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF0FDF4" },
        };
      });

      const onlyHeaders = [
        "ID",
        "ФО",
        "Объект",
        "Этап",
        "Статус",
        "Общая",
        "Строит.",
      ];
      const widths = [12, 15, 20, 30, 18, 16, 16];
      const onlyX = addSheet(
        workbook,
        `Только в ${right}`.slice(0, 31),
        onlyHeaders,
        widths,
      );
      d.onlyX.forEach((r) => {
        const row = onlyX.addRow([
          r.id,
          r["ФО"],
          r["объект"],
          r["этап"],
          r["статус"],
          r["общая площадь"] ?? "",
          r["площадь строительства"] ?? "",
        ]);
        row.eachCell((cell) => {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF0FDF4" },
          };
        });
      });

      const onlyG = addSheet(
        workbook,
        `Только в ${left}`.slice(0, 31),
        onlyHeaders,
        widths,
      );
      d.onlyG.forEach((r) => {
        const row = onlyG.addRow([
          r.id,
          r["ФО"],
          r["объект"],
          r["этап"],
          r["статус"],
          r["общая площадь"] ?? "",
          r["площадь строительства"] ?? "",
        ]);
        row.eachCell((cell) => {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFEF2F2" },
          };
        });
      });

      if (d.fuzzy.length) {
        const fuzzy = addSheet(
          workbook,
          "Приблизительные пары",
          [
            "ID",
            "ФО",
            "Объект",
            "Этап слева",
            "Этап справа",
            "Статус слева",
            "Статус справа",
          ],
          [12, 15, 20, 28, 28, 18, 18],
        );
        d.fuzzy.forEach(([g, x]) =>
          fuzzy.addRow([
            g.id,
            g["ФО"],
            g["объект"],
            g["этап"],
            x["этап"],
            g["статус"],
            x["статус"],
          ]),
        );
      }

      downloadBlob(
        await workbook.xlsx.writeBuffer(),
        `report_${fileStamp()}.xlsx`,
      );
      showToast("Отчёт сохранён", "success", 3000);
    } catch (e) {
      console.error(e);
      showToast("Не удалось сформировать отчёт: " + e.message, "error", 7000);
    }
  }

  // ---------------------------------------------------------------------------
  // Загрузка данных и кэш
  // ---------------------------------------------------------------------------
  function readCache(ignoreTtl = false) {
    try {
      const raw = sessionStorage.getItem(CONFIG.cacheKey);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (
        !cached ||
        !Array.isArray(cached.rows) ||
        !Array.isArray(cached.headers)
      )
        return null;
      if (!ignoreTtl && Date.now() - cached.ts > CONFIG.cacheTtlMs) return null;
      return cached;
    } catch {
      return null;
    }
  }

  function writeCache(payload) {
    try {
      sessionStorage.setItem(
        CONFIG.cacheKey,
        JSON.stringify({ ts: Date.now(), ...payload }),
      );
    } catch {
      /* превышена квота — просто работаем без кэша */
    }
  }

  function updateTimestamp(ts) {
    const el = $("updated-at");
    if (!el) return;
    if (!ts) {
      el.textContent = "";
      el.removeAttribute("title");
      return;
    }
    const date = new Date(ts);
    el.textContent = `обновлено ${date.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
    el.title = date.toLocaleString("ru-RU");
  }

  function setLoading(on, message) {
    const bar = $("loading-bar");
    if (bar) bar.hidden = !on;
    const refresh = $("btn-refresh");
    if (refresh) refresh.disabled = !!on;
    const loading = $("dashboard-loading");
    if (loading) {
      if (on && !state.allData.length) {
        loading.style.display = "block";
        loading.textContent = message || "Загружаю данные...";
      } else if (!on && state.allData.length) {
        loading.style.display = "none";
      }
    }
  }

  function applyData(headers, rows, meta = {}) {
    state.allData = processData(headers, rows);
    processAllData();
    if (meta.ts) updateTimestamp(meta.ts);
    if (meta.fromCache) showToast("Показаны данные из кэша", "info", 3000);
  }

  async function loadData({ force = false } = {}) {
    const cached = force ? null : readCache();
    if (cached) {
      applyData(cached.headers, cached.rows, {
        ts: cached.ts,
        fromCache: true,
      });
      return;
    }

    setLoading(true, "Загружаю данные...");
    try {
      const { headers, rows } = await loadGoogleSheet();
      if (!headers.length) throw new Error("лист не содержит заголовков");
      writeCache({ headers, rows });
      applyData(headers, rows, { ts: Date.now() });
    } catch (e) {
      console.error(e);
      const fallback = readCache(true);
      if (fallback) {
        applyData(fallback.headers, fallback.rows, { ts: fallback.ts });
        showToast(
          `Не удалось обновить: ${e.message}. Показаны сохранённые данные.`,
          "warning",
          8000,
        );
      } else {
        const loading = $("dashboard-loading");
        if (loading) {
          loading.style.display = "block";
          loading.innerHTML = `<span class="load-error">Не удалось загрузить данные: ${esc(
            e.message,
          )}</span>`;
        }
        showToast("Не удалось загрузить данные: " + e.message, "error", 0);
      }
    } finally {
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Навигация и обработчики
  // ---------------------------------------------------------------------------
  function scrollMainTop() {
    const el = $("main-content");
    if (el) el.scrollTo({ top: 0, behavior: "smooth" });
  }

  function activateTab(tab, { scroll = true } = {}) {
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll(".tab-content").forEach((panel) => {
      const active = panel.id === "tab-" + tab;
      panel.style.display = active ? "block" : "none";
      panel.setAttribute("aria-hidden", String(!active));
    });
    if (tab === "map") ensureMap();
    if (scroll) scrollMainTop();
  }

  function initTabs() {
    const buttons = [...document.querySelectorAll(".nav-btn")];
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
      btn.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const index = buttons.indexOf(btn);
        const next =
          buttons[
            (index + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) %
              buttons.length
          ];
        next.focus();
        activateTab(next.dataset.tab);
      });
    });
    activateTab("dashboard", { scroll: false });

    const dashboard = $("tab-dashboard");
    if (!dashboard) return;
    dashboard.addEventListener("click", (e) => {
      const card = e.target.closest("[data-drill]");
      if (card) drillDown(card.dataset.drill);
    });
    dashboard.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest("[data-drill]");
      if (!card) return;
      e.preventDefault();
      drillDown(card.dataset.drill);
    });
  }

  function toggleFilterGroup(header) {
    const group = header.closest(".filter-group");
    if (!group) return;
    const open = group.classList.toggle("open");
    header.setAttribute("aria-expanded", String(open));
  }

  function initSidebar() {
    const sidebar = $("sidebar");
    if (!sidebar) return;

    document.querySelectorAll(".filter-header").forEach((header) => {
      const group = header.closest(".filter-group");
      header.setAttribute(
        "aria-expanded",
        String(!!group && group.classList.contains("open")),
      );
    });

    sidebar.addEventListener("click", (e) => {
      const action = e.target.closest(".filter-actions");
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        setFilterAll(action.dataset.target, action.dataset.action === "all");
        return;
      }
      const header = e.target.closest(".filter-header");
      if (header) toggleFilterGroup(header);
    });

    sidebar.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const header = e.target.closest(".filter-header");
      if (!header) return;
      e.preventDefault();
      toggleFilterGroup(header);
    });

    sidebar.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-filter]");
      if (!cb) return;
      const key = cb.dataset.filter;
      if (!state.filters[key]) state.filters[key] = new Set();
      if (cb.checked) state.filters[key].add(cb.value);
      else state.filters[key].delete(cb.value);
      if (state.seen[key]) state.seen[key].add(cb.value);
      applyFilters();
      saveState();
    });
  }

  function initTableHandlers() {
    const head = $("main-table-head");
    if (!head) return;
    head.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (th) sortTable(th.dataset.sort);
    });
    head.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      e.preventDefault();
      sortTable(th.dataset.sort);
    });
  }

  function toggleTooltip(wrap) {
    const table = $("year-table");
    if (!table) return;
    const open = wrap.classList.contains("tip-open");
    table
      .querySelectorAll(".tooltip-wrap.tip-open")
      .forEach((el) => el.classList.remove("tip-open"));
    if (!open) wrap.classList.add("tip-open");
  }

  function initYearTableHandlers() {
    const select = $("year-select");
    if (select) {
      select.addEventListener("change", (e) => {
        state.selectedYear = Number(e.target.value);
        saveState();
        renderYearTable(state.rawData, state.selectedYear);
      });
    }

    const table = $("year-table");
    if (!table) return;
    table.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const wrap = e.target.closest(".tooltip-wrap");
      if (wrap) toggleTooltip(wrap);
    });
    table.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const wrap = e.target.closest(".tooltip-wrap");
      if (!wrap) return;
      e.preventDefault();
      toggleTooltip(wrap);
    });
  }

  function initHeader() {
    const toggle = $("toggle-bvs");
    if (toggle) {
      toggle.checked = state.showBVS;
      toggle.addEventListener("change", (e) => {
        state.showBVS = e.target.checked;
        processAllData();
        saveState();
      });
    }

    const refresh = $("btn-refresh");
    if (refresh) {
      refresh.addEventListener("click", () => {
        try {
          sessionStorage.removeItem(CONFIG.cacheKey);
        } catch {
          /* ignore */
        }
        loadData({ force: true });
      });
    }
  }

  function initExport() {
    const btn = $("btn-export-excel");
    if (btn) btn.addEventListener("click", exportSelection);
  }

  function initMapHandlers() {
    const notice = $("map-notice");
    if (!notice) return;
    notice.addEventListener("click", (e) => {
      if (!e.target.closest("[data-map-force]")) return;
      state.mapForceLoad = true;
      hideMapNotice();
      ensureMap();
    });
  }

  function initCompare() {
    if ($("gsheet-id-comp")) $("gsheet-id-comp").value = CONFIG.sheetId;
    if ($("gsheet-name-comp")) $("gsheet-name-comp").value = CONFIG.sheetName;

    const radios = [...document.querySelectorAll('input[name="compare-mode"]')];
    radios.forEach((radio, index) => {
      radio.addEventListener("change", () => {
        if ($("mode-slider"))
          $("mode-slider").style.transform = `translateX(${index * 100}%)`;
        state.compare.mode = radio.value;
        const google = state.compare.mode === "g_vs_x";
        if ($("google-fields"))
          $("google-fields").style.display = google ? "block" : "none";
        if ($("left-icon")) {
          $("left-icon").className = google ? "card-icon g" : "card-icon x";
          $("left-icon").textContent = google ? "G" : "X";
        }
        if ($("left-title")) {
          $("left-title").textContent = google
            ? "Google Sheets"
            : "Excel-файл (старый)";
        }
        if ($("right-title")) {
          $("right-title").textContent = google
            ? "Excel-файл"
            : "Excel-файл (новый)";
        }
        state.compare.left = null;
        state.compare.right = null;
        state.compare.result = null;
        if ($("compare-upload-screen"))
          $("compare-upload-screen").style.display = "block";
        if ($("compare-report-screen"))
          $("compare-report-screen").style.display = "none";
        ["file-left-comp", "file-right-comp"].forEach((id) => {
          const el = $(id);
          if (el) el.value = "";
        });
        [
          "fn-left-comp",
          "fn-right-comp",
          "status-g-comp",
          "status-x-comp",
        ].forEach((id) => {
          const el = $(id);
          if (el) el.textContent = "";
        });
        updateCompareBtn();
      });
    });

    const loadButton = $("btn-load-g-comp");
    if (loadButton) {
      loadButton.addEventListener("click", async () => {
        const id = $("gsheet-id-comp").value.trim();
        const name = $("gsheet-name-comp").value.trim() || "data";
        if (!id) {
          showToast("Укажите ID таблицы", "warning");
          return;
        }
        loadButton.disabled = true;
        setCompareStatus("status-g-comp", "Загрузка...", "muted");
        try {
          const data = await loadGoogleSheet(id, name);
          applyCompareSource(
            "left",
            { ...data, type: "google" },
            "status-g-comp",
          );
        } catch (e) {
          console.error(e);
          state.compare.left = null;
          setCompareStatus("status-g-comp", "Ошибка: " + e.message, "error");
          showToast(
            "Не удалось загрузить Google Sheets: " + e.message,
            "error",
            7000,
          );
          updateCompareBtn();
        } finally {
          loadButton.disabled = false;
        }
      });
    }

    const bindFile = (inputId, nameId, statusId, side) => {
      const input = $(inputId);
      if (!input) return;
      input.addEventListener("click", () => {
        input.value = "";
      });
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if ($(nameId)) $(nameId).textContent = file.name;
        setCompareStatus(statusId, "Чтение файла...", "muted");
        input.disabled = true;
        try {
          const data = await readXlsxComp(file, ["data", "Data", "Данные"]);
          applyCompareSource(side, { ...data, type: "excel" }, statusId);
        } catch (e) {
          console.error(e);
          if (side === "left") state.compare.left = null;
          else state.compare.right = null;
          setCompareStatus(
            statusId,
            "Ошибка чтения файла: " + e.message,
            "error",
          );
          showToast("Не удалось прочитать Excel: " + e.message, "error", 7000);
          updateCompareBtn();
        } finally {
          input.disabled = false;
        }
      });
    };
    bindFile("file-left-comp", "fn-left-comp", "status-g-comp", "left");
    bindFile("file-right-comp", "fn-right-comp", "status-x-comp", "right");

    const run = $("btn-run-comp");
    if (run) run.addEventListener("click", runComparisonComp);

    const back = $("btn-back-comp");
    if (back) {
      back.addEventListener("click", () => {
        $("compare-upload-screen").style.display = "block";
        $("compare-report-screen").style.display = "none";
      });
    }

    const download = $("btn-dl-comp");
    if (download) download.addEventListener("click", downloadCompareXlsx);

    const content = $("compare-content");
    if (!content) return;
    content.addEventListener("click", (e) => {
      const tab = e.target.closest(".tab[data-tab]");
      if (!tab) return;
      content.querySelectorAll(".tab").forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
      });
      content
        .querySelectorAll(".panel")
        .forEach((panel) => panel.classList.add("hidden"));
      const panel = $("panel-" + tab.dataset.tab);
      if (panel) panel.classList.remove("hidden");
    });
    content.addEventListener("input", (e) => {
      if (e.target.matches("input.filter")) renderCompareRows();
    });
  }

  // ---------------------------------------------------------------------------
  // Deep-link на таблицу с фильтром по объекту (из карты)
  // ---------------------------------------------------------------------------
  function handleHash() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return;
    const [route, queryString] = raw.split("?");
    if (route !== "table") return;
    activateTab("table");
    const params = new URLSearchParams(queryString || "");
    const obj = params.get("obj");
    if (obj) {
      state.filters.obj = new Set([obj]);
      if (state.seen.obj) state.seen.obj.add(obj);
      renderFilterOptions();
      applyFilters();
      saveState();
    }
  }

  function initHash() {
    window.addEventListener("hashchange", handleHash);
    handleHash();
  }

  // ---------------------------------------------------------------------------
  // Старт
  // ---------------------------------------------------------------------------
  function init() {
    loadState();
    initTabs();
    initHeader();
    initColumnsManager();
    initSidebar();
    initTableHandlers();
    initYearTableHandlers();
    initExport();
    initMapHandlers();
    initCompare();
    initHash();
    loadData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
