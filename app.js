/* БОС · Аналитика.
   Классический скрипт (не ES-модуль), чтобы приложение работало и при открытии
   index.html напрямую с диска. */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Конфигурация
  // ---------------------------------------------------------------------------
  const MAP_KEY_STORAGE = "bos_maps_key";

  // Ключ карты задан в config.js (лежит в репозитории, ограничен по HTTP Referer).
  // Если ключа нет, приложение попросит вставить его на вкладке «Карта» и запомнит
  // в этом браузере; ключ можно передать и в адресе: ?mapsKey=…
  function resolveMapsKey() {
    const fromConfig = (window.BOS_CONFIG && window.BOS_CONFIG.mapsApiKey) || "";
    if (fromConfig) return fromConfig;
    let fromUrl = "";
    try {
      const params = new URLSearchParams(window.location.search);
      fromUrl = (params.get("mapsKey") || params.get("key") || "").trim();
    } catch {
      /* некорректный адрес */
    }
    if (fromUrl) {
      try {
        localStorage.setItem(MAP_KEY_STORAGE, fromUrl);
      } catch {
        /* localStorage недоступен */
      }
      try {
        const clean = new URL(window.location.href);
        clean.searchParams.delete("mapsKey");
        clean.searchParams.delete("key");
        window.history.replaceState({}, "", clean);
      } catch {
        /* history недоступен (file://) */
      }
      return fromUrl;
    }
    try {
      return localStorage.getItem(MAP_KEY_STORAGE) || "";
    } catch {
      return "";
    }
  }

  const CONFIG = {
    sheetId: "1mDdg8Z1KpH8iDbf9PMnqnEA0dp_FZY1T1ab0RpY0etM",
    sheetName: "data",
    // Ключ API Яндекс.Карт: https://developer.tech.yandex.ru/services/
    // Без ключа вкладка «Карта» показывает инструкцию вместо пустой карты.
    mapsApiKey: resolveMapsKey(),
    // Бесплатный тариф JS API считает загрузки карты; при достижении лимита
    // автозагрузка останавливается (счётчик локальный, см. README-рекомендации).
    mapsDailyLimit:
      (window.BOS_CONFIG && window.BOS_CONFIG.mapsDailyLimit) || 100,
    stateKey: "bos_analytics_state",
    cacheKey: "bos_analytics_cache",
    snapshotKey: "bos_analytics_snapshot",
    cacheTtlMs: 10 * 60 * 1000,
    autoRefreshMs: 5 * 60 * 1000,
    sheetTimeoutMs: 20000,
  };

  const FILTER_KEYS = ["fo", "obj", "category", "status", "year"];
  const FILTER_LABELS = {
    fo: "ФО",
    obj: "Объект",
    category: "Категория",
    status: "Статус",
    year: "Год РВ",
  };

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

  // Подсветка совпадений поиска: экранируем текст, затем оборачиваем найденное в <mark>.
  let searchHitQuery = "";
  let searchHitRe = null;
  const highlightSearch = (value) => {
    const safe = esc(value);
    const query = (state.search || "").trim();
    if (!query) return safe;
    if (query !== searchHitQuery) {
      const pattern = esc(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      searchHitQuery = query;
      searchHitRe = new RegExp(`(${pattern})`, "gi");
    }
    return safe.replace(searchHitRe, '<mark class="search-hit">$1</mark>');
  };

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
    let s = String(v).replace(/[\s\u00A0]/g, "");
    if (s === "" || s === "-" || s === "—") return null;
    const commas = (s.match(/,/g) || []).length;
    const dots = (s.match(/\./g) || []).length;
    if (commas && dots) {
      // Последний разделитель — десятичный, остальные считаем тысячами.
      s =
        s.lastIndexOf(",") > s.lastIndexOf(".")
          ? s.replace(/\./g, "").replace(",", ".")
          : s.replace(/,/g, "");
    } else if (commas > 1 || dots > 1) {
      s = s.replace(/[.,]/g, "");
    } else if (commas === 1) {
      s = s.replace(",", ".");
    }
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
  // Длинные формулировки источника сводим к коротким подписям (таблица, фильтр, Excel).
  const SOURCE_ALIASES = {
    "предварительная экспертная оценка планируемой площади строительства":
      "Экспертная оценка",
  };
  const canonicalSource = (v) => {
    const s = String(v ?? "").trim();
    if (!s) return "";
    return SOURCE_ALIASES[s.toLowerCase()] || s;
  };
  const statusConf = (s) =>
    STATUS_CONF[s] || { color: "#94a3b8", hex: "#94a3b8", badge: "gray" };

  // Этап = строка, где категория/этап не содержит «АБЧ». Правило используется
  // и в KPI, и на карте — держать в одном месте.
  const isAbchRow = (r) => /АБЧ/i.test(r.category) || /АБЧ/i.test(r.stage);

  // ---------------------------------------------------------------------------
  // Колонки
  // ---------------------------------------------------------------------------
  const COLUMN_DEFS = [
    { key: "obj", label: "Объект / Этап", class: "text-left", width: 34, w: 240 },
    { key: "category", label: "Категория", class: "text-left", width: 20, w: 150 },
    { key: "status", label: "Статус", class: "text-center", width: 16, w: 110 },
    { key: "areaBuild", label: "Стройка", class: "text-right", numeric: true, bold: true, width: 16, w: 105 },
    { key: "areaMezzanine", label: "Мезонин", class: "text-right", numeric: true, width: 16, w: 105 },
    { key: "areaOper", label: "Оперзона", class: "text-right", numeric: true, width: 16, w: 105 },
    { key: "areaFreeze", label: "Заморозка", class: "text-right", numeric: true, bold: true, width: 16, w: 105 },
    { key: "rvText", label: "РВ (Дата)", class: "text-center", width: 18, w: 120 },
    { key: "source", label: "Источник данных", class: "text-left", width: 24, w: 210 },
    { key: "damage", label: "Повреждения", class: "text-left", width: 22, w: 220 },
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
    filters: { fo: null, obj: null, category: null, status: null, year: null },
    // Ключи фильтров, заданные ссылкой (#table?obj=…): их набор не расширяем автоматически.
    pinned: new Set(),
    seen: {
      fo: new Set(),
      obj: new Set(),
      category: new Set(),
      status: new Set(),
      year: new Set(),
    },
    sort: { col: null, dir: 1 },
    search: "",
    compact: true,
    dataTs: null,
    loading: false,
    lastFingerprint: null,
    showBVS: true,
    selectedYear: new Date().getFullYear(),
    columnOrder: [...DEFAULT_COLUMNS],
    visible: new Set(DEFAULT_COLUMNS),
    map: null,
    markersLayer: null,
    mapLoading: null,
    mapSignature: null,
    mapForceLoad: false,
    compare: { left: null, right: null, mode: "g_vs_x", result: null },
  };

  // ---------------------------------------------------------------------------
  // Тема оформления: системная / светлая / тёмная
  // ---------------------------------------------------------------------------
  const THEME_KEY = "bos_theme";
  const THEME_MODES = ["system", "light", "dark"];
  const THEME_TITLES = {
    system: "как в системе",
    light: "светлая",
    dark: "тёмная",
  };
  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
  let themeMode = "system";

  function applyTheme(mode) {
    themeMode = THEME_MODES.includes(mode) ? mode : "system";
    const dark =
      themeMode === "dark" || (themeMode === "system" && darkScheme.matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const btn = $("btn-theme");
    if (btn) {
      btn.textContent =
        themeMode === "light" ? "☀" : themeMode === "dark" ? "☾" : "◐";
      btn.title = `Тема: ${THEME_TITLES[themeMode]} — нажмите, чтобы переключить`;
      btn.setAttribute("aria-label", btn.title);
      btn.setAttribute("aria-pressed", String(dark));
    }
    try {
      if (themeMode === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, themeMode);
    } catch {
      /* localStorage недоступен */
    }
  }

  function initTheme() {
    let saved = "system";
    try {
      saved = localStorage.getItem(THEME_KEY) || "system";
    } catch {
      /* localStorage недоступен */
    }
    applyTheme(saved);
    if (darkScheme.addEventListener) {
      darkScheme.addEventListener("change", () => {
        if (themeMode === "system") applyTheme("system");
      });
    }
    const btn = $("btn-theme");
    if (btn) {
      btn.addEventListener("click", () => {
        const next =
          THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
        applyTheme(next);
      });
    }
  }

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
          compact: state.compact,
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
      if (typeof s.compact === "boolean") state.compact = s.compact;
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
        const on = state.visible.has(col.key);
        return `<div class="dnd-item ${on ? "is-on" : ""}" draggable="true" data-key="${col.key}">
      <span class="dnd-handle" aria-hidden="true">☰</span>
      <input type="checkbox" data-col-key="${col.key}" ${on ? "checked" : ""} aria-label="Показывать столбец «${esc(col.label)}»">
      <span class="dnd-label">${esc(col.label)}</span>
    </div>`;
      })
      .join("");
  }

  function setColumnVisible(key, checked) {
    if (checked) state.visible.add(key);
    else state.visible.delete(key);
    if (!state.columnOrder.includes(key)) state.columnOrder.push(key);
    const chip = document.querySelector(`.dnd-item[data-key="${key}"]`);
    if (chip) chip.classList.toggle("is-on", checked);
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
        // Одноимённые колонки не перезаписывают друг друга.
        if (Object.prototype.hasOwnProperty.call(obj, headers[i])) return;
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
  function yearBucket(date) {
    const year = date.getFullYear();
    const currentYear = new Date().getFullYear();
    if (year < 2024) return "Ранее";
    if (year > currentYear) return "Далее";
    return String(year);
  }

  function processData(headers, rows) {
    // Имена колонок листа могут отличаться регистром/пробелами — ищем без учёта регистра.
    const headerByLower = new Map();
    (headers || []).forEach((h) => {
      const key = String(h || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (key && !headerByLower.has(key)) headerByLower.set(key, h);
    });
    return rows.map((r) => {
      const getVal = (k) => {
        const key = Object.prototype.hasOwnProperty.call(r, k)
          ? k
          : headerByLower.get(String(k).toLowerCase());
        return key !== undefined && r[key] !== undefined ? r[key] : null;
      };
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
      const dMatch = cleanRvText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (dMatch) date = new Date(+dMatch[3], +dMatch[2] - 1, +dMatch[1]);

      const rawStatus =
        getVal("статус площадки") || getVal("статус") || "Не указан";
      const status = canonicalStatus(rawStatus);
      let category = getVal("категория") || getVal("категория объекта") || "";
      if (category === "Вспомогательные объекты") category = "Прочее";

      // Капремонт — не наш объект: строку из источника полностью игнорируем.
      const kmText = [
        getVal("статус площадки"),
        getVal("статус"),
        getVal("этап"),
        getVal("объект"),
        getVal("категория"),
      ]
        .map((v) => String(v ?? "").toLowerCase())
        .join(" ");
      if (kmText.includes("капремонт")) return null;

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
        source: canonicalSource(getVal("источник данных площади")),
        damage: getVal("повреждения") || "",
        rvText: cleanRvText,
        rvLink,
        rvDate: date,
        rvSort: date ? date.getTime() : 0,
        year: date ? yearBucket(date) : "Без даты",
        badArea,
        isBVS:
          String(getVal("категория") || "").includes("БВС") ||
          String(getVal("объект") || "").includes("БВС") ||
          String(getVal("этап") || "").includes("БВС"),
      };
    }).filter(Boolean);
  }

  function stageLabel(r) {
    let s = r.stage || "";
    if (s && r.obj) {
      const escapedObj = r.obj.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      s = s.replace(new RegExp(escapedObj, "i"), "");
    }
    s = s.replace(/^[\s\-]+|[\s\-]+$/g, "").trim();
    // Снимаем скобки только если они обрамляют строку целиком:
    // «Алексин (БВС)» должен сохранить закрывающую скобку.
    if (/^\([^()]+\)$/.test(s)) s = s.slice(1, -1).trim();
    if (/^абч$/i.test(s)) s = "АБЧ";
    else if (/^бвс$/i.test(s)) s = "БВС";
    if (s === r.obj) s = "";
    return s;
  }

  // ---------------------------------------------------------------------------
  // Фильтры
  // ---------------------------------------------------------------------------
  const rowFilterValue = (r, key) => (key === "year" ? r.year : r[key]);

  const rowSearchMain = (r) =>
    [r.id, r.fo, r.obj, r.stage, r.category, r.status, r.rvText, r.source, r.damage]
      .join(" ")
      .toLowerCase();

  const YEAR_RANK = (v) => {
    if (v === "Ранее") return Number.NEGATIVE_INFINITY;
    if (v === "Далее") return Number.MAX_SAFE_INTEGER - 1;
    if (v === "Без даты") return Number.MAX_SAFE_INTEGER;
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER - 2;
  };

  const allValues = (key, data) => {
    const values = [
      ...new Set(data.map((r) => rowFilterValue(r, key)).filter(Boolean)),
    ];
    if (key === "year") return values.sort((a, b) => YEAR_RANK(a) - YEAR_RANK(b));
    return values.sort((a, b) => String(a).localeCompare(String(b), "ru"));
  };

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
    state.pinned.delete(key);
    state.filters[key] = all
      ? new Set(allValues(key, state.rawData))
      : new Set();
    renderFilterOptions();
    applyFilters();
    saveState();
  }

  function setSearch(value) {
    state.search = String(value || "");
    const input = $("table-search");
    if (input && input.value !== state.search) input.value = state.search;
    applyFilters();
  }

  function resetAllFilters() {
    state.pinned.clear();
    for (const key of FILTER_KEYS) {
      state.filters[key] = new Set(allValues(key, state.rawData));
    }
    state.search = "";
    const input = $("table-search");
    if (input) input.value = "";
    renderFilterOptions();
    applyFilters();
    saveState();
  }

  // Плашка «Выборка»: какие фильтры и поиск сейчас ограничивают таблицу.
  function renderFilterContext() {
    const host = $("table-context");
    if (!host) return;
    const chips = [];
    for (const key of FILTER_KEYS) {
      const all = allValues(key, state.rawData);
      const selected = state.filters[key];
      if (!selected || selected.size >= all.length) continue;
      const names = [...selected];
      const label =
        names.length <= 2 ? names.join(", ") : `${names.length} из ${all.length}`;
      chips.push(
        `<button type="button" class="filter-chip" data-clear-filter="${key}" title="Убрать фильтр «${esc(
          FILTER_LABELS[key],
        )}»">${esc(FILTER_LABELS[key])}: ${esc(label)} <span aria-hidden="true">×</span></button>`,
      );
    }
    const query = state.search.trim();
    if (query) {
      chips.push(
        `<button type="button" class="filter-chip" data-clear-search="1" title="Очистить поиск">Поиск: «${esc(
          query,
        )}» <span aria-hidden="true">×</span></button>`,
      );
    }
    if (!chips.length) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;
    host.innerHTML =
      '<span class="table-context-label">Выборка:</span>' +
      chips.join("") +
      '<button type="button" class="filter-chip filter-chip-reset" data-reset-all="1">Сбросить всё</button>';
  }

  function applyFilters() {
    const f = state.filters;
    const query = state.search.trim().toLowerCase();
    state.filteredData = state.rawData.filter(
      (r) =>
        FILTER_KEYS.every((k) => !f[k] || f[k].has(rowFilterValue(r, k))) &&
        (!query || rowSearchMain(r).includes(query)),
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
    renderFilterContext();
    renderTable();
  }

  function processAllData() {
    state.rawData = state.showBVS
      ? state.allData
      : state.allData.filter((r) => !r.isBVS);

    for (const key of FILTER_KEYS) {
      const values = allValues(key, state.rawData);
      if (!state.seen[key]) state.seen[key] = new Set();
      if (state.pinned.has(key)) continue;
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
    state.pinned.clear();
    for (const key of FILTER_KEYS) {
      state.filters[key] = new Set(allValues(key, state.rawData));
    }
    const currentYear = String(new Date().getFullYear());
    if (type === "delivered") {
      state.filters.status = new Set(["Завершено"]);
      state.filters.year = new Set([currentYear]);
    } else if (type === "remaining") {
      state.filters.status = new Set(["В работе"]);
      state.filters.year = new Set([currentYear]);
    }
    renderFilterOptions();
    applyFilters();
    saveState();
  }

  function drillDownYear(bucket) {
    activateTab("table");
    state.pinned.clear();
    for (const key of FILTER_KEYS) {
      state.filters[key] = new Set(allValues(key, state.rawData));
    }
    state.filters.year = new Set([bucket]);
    renderFilterOptions();
    applyFilters();
    saveState();
  }

  // ---------------------------------------------------------------------------
  // Таблица
  // ---------------------------------------------------------------------------
  function renderTable() {
    const defs = visibleColumnDefs();
    const table = $("main-table");
    const cols = $("main-table-cols");
    if (cols) {
      cols.innerHTML = defs
        .map((def) => `<col style="width:${def.w || 120}px">`)
        .join("");
    }
    if (table) {
      table.style.minWidth = `${defs.reduce((sum, def) => sum + (def.w || 120), 0)}px`;
    }
    const head = $("main-table-head");
    if (head) {
      head.innerHTML =
        "<tr>" +
        defs
          .map((def) => {
            const active = state.sort.col === def.key;
            const ariaSort = active
              ? state.sort.dir === 1
                ? "ascending"
                : "descending"
              : "none";
            const iconCls = active
              ? state.sort.dir === 1
                ? "sort-icon is-asc"
                : "sort-icon is-desc"
              : "sort-icon";
            return `<th class="${def.class}${active ? " is-sorted" : ""}" data-sort="${def.key}" tabindex="0" aria-sort="${ariaSort}"><span class="th-label">${esc(
              def.label,
            )}</span><svg class="${iconCls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"></polyline></svg></th>`;
          })
          .join("") +
        "</tr>";
    }

    const body = $("table-body");
    if (!body) return;

    body.innerHTML = state.filteredData.length
      ? state.filteredData.map((r) => renderRow(r, defs)).join("")
      : `<tr><td colspan="${Math.max(1, defs.length)}" class="empty-state">Ничего не найдено. Измените фильтры.</td></tr>`;

    const count = $("table-count");
    if (count) count.textContent = `${state.filteredData.length} из ${state.rawData.length}`;

    renderTableSummary(defs);
    renderTableFoot(defs);
  }

  // Итоги для печати: tfoot в конце реестра (на экране tfoot скрыт).
  function totalsRowMarkup(defs) {
    if (!state.filteredData.length) return "";
    const sums = new Map();
    for (const def of defs) {
      if (!def.numeric) continue;
      sums.set(
        def.key,
        state.filteredData.reduce((sum, r) => sum + (r[def.key] || 0), 0),
      );
    }
    const n = state.filteredData.length;
    const cells = defs.map((def, index) => {
      if (def.numeric) {
        return `<td class="${def.class}">${showNum(sums.get(def.key))}</td>`;
      }
      if (index === 0) {
        return `<th class="${def.class}" scope="row">Итого · ${n} ${plural(n, [
          "строка",
          "строки",
          "строк",
        ])}</th>`;
      }
      return `<td class="${def.class}"></td>`;
    });
    return `<tr class="total-row">${cells.join("")}</tr>`;
  }

  // Сводка под заголовком карточки: объекты, этапы/АБЧ, статусы, площади, РВ.
  function renderTableSummary(defs) {
    const host = $("table-stats");
    if (!host) return;
    const data = state.filteredData;
    if (!data.length) {
      host.innerHTML = "";
      return;
    }
    const objects = new Set(data.map((r) => r.obj).filter(Boolean)).size;
    const abch = data.filter(isAbchRow).length;
    const stages = data.length - abch;
    const sum = (key) => data.reduce((acc, r) => acc + (r[key] || 0), 0);
    const area = sum("areaBuild");
    const shortNum = (v) =>
      v >= 1e6
        ? `${(v / 1e6).toLocaleString("ru-RU", {
            maximumFractionDigits: 2,
          })} млн`
        : v >= 1e3
          ? `${(v / 1e3).toLocaleString("ru-RU", {
              maximumFractionDigits: 1,
            })} тыс.`
          : fmt(v);
    const areaTitle = `Площадь: ${fmt(area)} м² · Стройка ${fmt(
      sum("areaBuild"),
    )} · Мезонин ${fmt(sum("areaMezzanine"))} · Оперзона ${fmt(
      sum("areaOper"),
    )} · Заморозка ${fmt(sum("areaFreeze"))}`;

    const statusCount = new Map();
    for (const r of data) {
      statusCount.set(r.status, (statusCount.get(r.status) || 0) + 1);
    }
    const order = [
      ...Object.keys(STATUS_CONF),
      ...[...statusCount.keys()].filter((s) => !STATUS_CONF[s]),
    ];
    const statusHtml = order
      .filter((s) => statusCount.has(s))
      .map(
        (s) =>
          `<span class="stat-item"><i class="stat-dot" style="background:${
            (STATUS_CONF[s] && STATUS_CONF[s].color) || "#64748b"
          }"></i>${esc(s)} <b>${statusCount.get(s)}</b></span>`,
      )
      .join("");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let rvDone = 0;
    let rvPlan = 0;
    for (const r of data) {
      if (!r.rvDate) continue;
      if (r.rvDate < today) rvDone++;
      else rvPlan++;
    }

    host.innerHTML = `
      <div class="stat-line"><span class="stat-item"><b>${data.length}</b> ${plural(
        data.length,
        ["строка", "строки", "строк"],
      )} · <b>${objects}</b> ${plural(objects, [
        "объект",
        "объекта",
        "объектов",
      ])} · <b>${stages}</b> ${plural(stages, [
        "этап",
        "этапа",
        "этапов",
      ])} · <b>${abch}</b> АБЧ</span></div>
      <div class="stat-line">${statusHtml}</div>
      <div class="stat-line">
        <span class="stat-item" title="РВ получено — дата в прошлом, к получению — в будущем">РВ: получено <b>${rvDone}</b> · к получению <b>${rvPlan}</b></span>
        <span class="stat-item" title="${esc(areaTitle)}">Площадь <b>${shortNum(
          area,
        )}</b> м²</span>
      </div>`;
  }

  function renderTableFoot(defs) {
    const foot = $("table-foot");
    if (!foot) return;
    foot.innerHTML = totalsRowMarkup(defs);
  }

  function renderRow(r, defs) {
    const conf = statusConf(r.status);
    const href = r.rvLink ? safeUrl(r.rvLink) : "";
    const dateHtml = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="raw-link">${esc(
          r.rvText || "Ссылка",
        )}</a>`
      : linkify(r.rvText);
    const stage = stageLabel(r);

    const cells = defs.map((def) => {
      const label = `data-label="${esc(def.label)}"`;
      if (def.key === "obj") {
        // Обёртка центрирует название по вертикали, когда этапа нет.
        return `<td ${label} class="${def.class}"><div class="cell-stack"><div class="cell-title" title="${esc(
          r.obj,
        )}">${highlightSearch(r.obj)}</div><div class="cell-sub" title="${esc(
          stage,
        )}">${highlightSearch(stage)}</div></div></td>`;
      }
      if (def.key === "status") {
        return `<td ${label} class="${def.class}"><span class="status-badge ${conf.badge}">${highlightSearch(
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
      return `<td ${label} class="${def.class}${cls}" title="${esc(
        r[def.key],
      )}">${highlightSearch(r[def.key])}</td>`;
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

    // Этапы = все строки, кроме АБЧ. Статусы считаем по этапам, а не по объектам:
    // у объекта этапы бывают в разных статусах, и «статус объекта» был бы условным.
    const abchCount = data.filter(isAbchRow).length;
    const stageCount = data.length - abchCount;
    const stagesHost = $("kpi-objects-stages");
    if (stagesHost) {
      stagesHost.innerHTML =
        `<span><b>${stageCount}</b> ${plural(stageCount, [
          "этап",
          "этапа",
          "этапов",
        ])}</span>` +
        `<span><b>${abchCount}</b> АБЧ</span>`;
    }

    const statusCounts = new Map();
    data.forEach((r) => {
      const status = r.status || "Не указан";
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    });
    const statusRows = [...statusCounts.entries()].sort((a, b) => {
      const ia = STATUS_ORDER.indexOf(a[0]);
      const ib = STATUS_ORDER.indexOf(b[0]);
      if (ia === -1 && ib === -1) return b[1] - a[1];
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    const statusBar = $("kpi-objects-bar");
    if (statusBar) {
      const total = statusRows.reduce((sum, [, n]) => sum + n, 0) || 1;
      statusBar.innerHTML = statusRows
        .map(
          ([status, n]) =>
            `<span style="width:${(n / total) * 100}%;background:${
              statusConf(status).color
            }" title="${esc(status)}: ${n}"></span>`,
        )
        .join("");
    }
    const statusList = $("kpi-objects-statuses");
    if (statusList) {
      statusList.innerHTML = statusRows
        .map(
          ([status, n]) =>
            `<li><i style="background:${statusConf(status).color}"></i><span>${esc(
              status,
            )}</span><b>${n}</b></li>`,
        )
        .join("");
    }
    const allObjectsCard = document.querySelector('[data-drill="all"]');
    if (allObjectsCard) {
      allObjectsCard.title =
        `Объектов: ${objects.size}, этапов: ${stageCount}, АБЧ: ${abchCount}` +
        ` · статусы этапов — ${statusRows
          .map(([status, n]) => `${status}: ${n}`)
          .join(", ")}`;
    }

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
          return `<div class="bar-item clickable" data-year="${esc(
            year,
          )}" role="button" tabindex="0" aria-label="Показать объекты: ${esc(
            year,
          )}"><div class="bar-label">${esc(
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
    state.selectedYear = year;

    select.innerHTML = sorted
      .map(
        (y) =>
          `<option value="${y}" ${y === year ? "selected" : ""}>${y} год</option>`,
      )
      .join("");
    renderYearTable(data, year);
  }

  // ---------------------------------------------------------------------------
  // Карта
  // ---------------------------------------------------------------------------
  // Координаты площадок и подбор точки — в coords.js (window.BOS_COORDS).
  const coordsFor = (obj) => window.BOS_COORDS.resolve(obj);

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
      // Тайлы Яндекс рисует либо в <img> (старые версии), либо в <canvas> внутри
      // ground-pane. Селекторы без привязки к версии API, чтобы не ломались при обновлении.
      const tiles = mapEl.querySelectorAll(
        '[class*="ground-pane"] img, [class*="ground-pane"] canvas, [class*="tile"] img, [class*="tile"] canvas',
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
            "Если ключ верный, дело в сети: VPN, прокси, блокировщики и фильтры DNS иногда режут " +
            "домен core-renderer-tiles.maps.yandex.net. " +
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
    // Дата локальная: счётчик должен обнуляться в местную полночь, а не по UTC.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(now.getDate()).padStart(2, "0")}`;
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
        "Карта недоступна: не задан API-ключ Яндекс.Карт. Ключ нужен от сервиса " +
          '<a href="https://developer.tech.yandex.ru/services/" target="_blank" rel="noopener noreferrer">«JavaScript API и Геокодер»</a>. ' +
          "Вставьте его ниже — он сохранится только в этом браузере и не попадёт в репозиторий:" +
          '<div class="map-key-row">' +
          '<input type="password" id="map-key-input" class="map-key-input" placeholder="Ключ JavaScript API" autocomplete="off" aria-label="API-ключ Яндекс.Карт">' +
          '<button type="button" class="btn btn-primary" data-map-key-save="1">Сохранить и загрузить</button>' +
          "</div>" +
          '<div class="map-key-hint">Этот же ключ можно передать в адресе страницы: <code>?mapsKey=ВАШ_КЛЮЧ</code></div>',
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
                state.mapSignature = null;
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
        // Сбрасываем промис API: иначе после ввода другого ключа скрипт не перезагрузится.
        mapsPromise = null;
        showMapNotice(`Не удалось загрузить карту: ${esc(e.message)}`);
      });
  }

  // Метка рисуется SVG-картинкой: так Яндекс не перерисовывает DOM-разметку 68 меток
  // при каждом зуме (из-за этого карта подвисала), и клик всегда попадает в метку.
  function pieImageUrl(statusAreas) {
    const entries = Object.entries(statusAreas).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, area]) => sum + area, 0);
    const r = 10;
    let angle = -Math.PI / 2;
    const slices = entries
      .map(([status, area]) => {
        const sweep = total ? (area / total) * Math.PI * 2 : 0;
        const x1 = 12 + r * Math.cos(angle);
        const y1 = 12 + r * Math.sin(angle);
        angle += sweep;
        const x2 = 12 + r * Math.cos(angle);
        const y2 = 12 + r * Math.sin(angle);
        const large = sweep > Math.PI ? 1 : 0;
        const d = `M12 12 L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
        return `<path d="${d}" fill="${statusConf(status).hex}"/>`;
      })
      .join("");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
      `<circle cx="12" cy="12" r="11.5" fill="#ffffff"/>` +
      `<circle cx="12" cy="12" r="10" fill="#e2e8f0"/>${slices}</svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
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
        grouped.set(r.obj, {
          coords,
          area: 0,
          stages: 0,
          abch: 0,
          statusAreas: {},
        });
      }
      const g = grouped.get(r.obj);
      g.area += r.areaBuild;
      // АБЧ считаем отдельно, остальное (склад, СЦ, промпарк, производство, БВС) — этапы.
      if (isAbchRow(r)) g.abch++;
      else g.stages++;
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

    // Если данные не изменились (обновление по таймеру, повторный вход на вкладку),
    // слой меток не пересобираем — иначе карта дёргается и теряет зум.
    const signature = [...grouped.entries()]
      .map(
        ([city, d]) =>
          `${city}:${d.coords.join(",")}:${Math.round(d.area)}:${d.stages}:${d.abch}:` +
          Object.entries(d.statusAreas)
            .map(([st, a]) => st + Math.round(a))
            .join("|"),
      )
      .join(";");
    if (signature === state.mapSignature) return;
    state.mapSignature = signature;

    state.markersLayer.removeAll();

    grouped.forEach((d, city) => {
      const stageLines = [
        d.stages ? `Этапов: ${d.stages}` : "",
        d.abch ? `АБЧ: ${d.abch}` : "",
      ].filter(Boolean);
      const placemark = new ymaps.Placemark(
        d.coords,
        {
          hintContent: esc(city),
          balloonContentHeader: `<b class="map-balloon-title">${esc(city)}</b>`,
          balloonContentBody: `
        <div class="map-balloon">
          ${stageLines.join("<br>") || "Этапов: 0"}<br>
          Площадь: ${fmt(d.area)} м²<br>
          <a href="#table?obj=${encodeURIComponent(city)}">Показать в таблице</a>
        </div>`,
        },
        {
          iconLayout: "default#image",
          iconImageHref: pieImageUrl(d.statusAreas),
          iconImageSize: [24, 24],
          iconImageOffset: [-12, -12],
        },
      );
      state.markersLayer.add(placemark);
    });
  }

  // ---------------------------------------------------------------------------
  // Диагностика «фризов» на конкретном устройстве: откройте страницу с ?debug=1
  // ---------------------------------------------------------------------------
  // Диагностический оверлей ?debug=1 — в debug-hud.js (window.BOS_DEBUG_HUD).

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
    await ensureExcelJs();
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
  // ExcelJS грузится по требованию — см. excel-loader.js (window.BOS_EXCEL).
  const ensureExcelJs = () => window.BOS_EXCEL.load();

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

  function describeFilters() {
    const parts = [];
    for (const key of FILTER_KEYS) {
      const all = allValues(key, state.rawData).length;
      const selected = state.filters[key];
      if (selected && selected.size !== all) {
        parts.push(`${FILTER_LABELS[key]}: ${selected.size} из ${all}`);
      }
    }
    if (!state.showBVS) parts.push("БВС скрыты");
    return parts.length ? parts.join("; ") : "Все данные";
  }

  async function exportSelection() {
    if (!state.filteredData.length) {
      showToast("Нет данных для экспорта", "warning");
      return;
    }
    try {
      await ensureExcelJs();
      const defs = visibleColumnDefs();
      const workbook = new ExcelJS.Workbook();

      const objects = new Set(state.filteredData.map((r) => r.obj).filter(Boolean)).size;
      const totalArea = state.filteredData.reduce((sum, r) => sum + r.areaBuild, 0);
      const summary = addSheet(workbook, "Сводка", ["Показатель", "Значение"], [38, 46]);
      summary.addRow(["Дата выгрузки", new Date().toLocaleString("ru-RU")]);
      summary.addRow(["Источник", `Google Sheets · ${CONFIG.sheetName}`]);
      summary.addRow(["Строк в выборке", state.filteredData.length]);
      summary.addRow(["Объектов", objects]);
      const areaRow = summary.addRow(["Площадь стройки, м²", totalArea]);
      areaRow.getCell(2).numFmt = "# ##0.00";
      summary.addRow(["Фильтры", describeFilters()]);
      summary.addRow(["БВС", state.showBVS ? "показываются" : "скрыты"]);

      const byStatus = new Map();
      state.filteredData.forEach((r) => {
        const item = byStatus.get(r.status) || { count: 0, area: 0 };
        item.count += 1;
        item.area += r.status === "Отказ" ? r.areaFreeze : r.areaBuild;
        byStatus.set(r.status, item);
      });
      summary.addRow([]);
      [...byStatus.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "ru"))
        .forEach(([status, item]) => {
          summary.addRow([
            "Статус: " + status,
            `${item.count} ${plural(item.count, ["строка", "строки", "строк"])} · ${fmt(
              item.area,
            )} м²`,
          ]);
        });

      const sheet = addSheet(
        workbook,
        "Выборка",
        defs.map((d) => d.label),
        defs.map((d) => d.width || 16),
      );
      const rvIndex = defs.findIndex((d) => d.key === "rvText");
      state.filteredData.forEach((r) => {
        const row = sheet.addRow(
          defs.map((def) => {
            if (def.key === "obj") {
              const stage = stageLabel(r);
              return stage ? `${r.obj} / ${stage}` : r.obj;
            }
            return r[def.key] ?? "";
          }),
        );
        if (rvIndex >= 0 && r.rvLink) {
          const url = safeUrl(r.rvLink);
          if (url) {
            const cell = row.getCell(rvIndex + 1);
            cell.value = { text: r.rvText || "Ссылка", hyperlink: url, tooltip: url };
            cell.font = { color: { argb: "FF2563EB" }, underline: true };
          }
        }
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
    const { left, right } = compareModeLabels();
    try {
      await ensureExcelJs();
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

  // Офлайн-копия последней удачной загрузки живёт в localStorage и переживает
  // закрытие вкладки: нужна, если Google-таблица временно недоступна.
  function readSnapshot() {
    try {
      const raw = localStorage.getItem(CONFIG.snapshotKey);
      if (!raw) return null;
      const snap = JSON.parse(raw);
      if (!snap || !Array.isArray(snap.headers) || !snap.headers.length)
        return null;
      if (!Array.isArray(snap.rows) || !snap.rows.length) return null;
      return snap;
    } catch {
      return null;
    }
  }

  function writeSnapshot(headers, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    try {
      localStorage.setItem(
        CONFIG.snapshotKey,
        JSON.stringify({ ts: Date.now(), headers, rows }),
      );
    } catch {
      /* квота localStorage — работаем без офлайн-копии */
    }
  }

  function updateTimestamp(ts, label = "обновлено") {
    const el = $("updated-at");
    state.dataTs = ts || null;
    if (!el) return;
    if (!ts) {
      el.textContent = "";
      el.removeAttribute("title");
      return;
    }
    const date = new Date(ts);
    const time = date.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    // Если данные не за сегодня — показываем и дату, иначе «обновлено 23:49» неинформативно.
    const sameDay = date.toDateString() === new Date().toDateString();
    const day = date.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
    });
    el.textContent = sameDay ? `${label} ${time}` : `${label} ${day}, ${time}`;
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

  function dataFingerprint(headers, rows) {
    const text = headers.join("|") + "|" + JSON.stringify(rows);
    let hash = 5381;
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return String(hash);
  }

  function applyData(headers, rows, meta = {}) {
    const fingerprint = dataFingerprint(headers, rows);
    const changed =
      state.lastFingerprint !== null && fingerprint !== state.lastFingerprint;
    state.lastFingerprint = fingerprint;
    state.allData = processData(headers, rows);
    processAllData();
    const badAreaRows = state.allData.filter((r) => r.badArea).length;
    if (badAreaRows) {
      showToast(
        `Площадь не распознана в ${badAreaRows} ${plural(badAreaRows, [
          "строке",
          "строках",
          "строках",
        ])} — учтена как 0`,
        "warning",
        8000,
      );
    }
    if (meta.ts) updateTimestamp(meta.ts);
    if (meta.fromCache) showToast("Показаны данные из кэша", "info", 3000);
    if (meta.auto && changed) showToast("Данные обновлены", "info", 2500);
  }

  async function loadData({ force = false, silent = false, auto = false } = {}) {
    if (state.loading) return;
    const cached = force || auto ? null : readCache();
    if (cached) {
      writeSnapshot(cached.headers, cached.rows);
      applyData(cached.headers, cached.rows, {
        ts: cached.ts,
        fromCache: true,
      });
      return;
    }

    state.loading = true;
    if (!silent) setLoading(true, "Загружаю данные...");
    try {
      const { headers, rows } = await loadGoogleSheet();
      if (!headers.length) throw new Error("лист не содержит заголовков");
      writeCache({ headers, rows });
      writeSnapshot(headers, rows);
      applyData(headers, rows, { ts: Date.now(), auto });
    } catch (e) {
      console.error(e);
      if (auto) {
        showToast("Не удалось обновить данные автоматически", "warning", 4000);
        return;
      }
      const fallback = readCache(true) || readSnapshot();
      if (fallback) {
        applyData(fallback.headers, fallback.rows, { ts: fallback.ts });
        updateTimestamp(fallback.ts, "офлайн-копия от");
        showToast(
          `Не удалось обновить: ${e.message}. Показана сохранённая копия от ${new Date(
            fallback.ts,
          ).toLocaleString("ru-RU")}.`,
          "warning",
          10000,
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
      state.loading = false;
      if (!silent) setLoading(false);
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
      panel.classList.toggle("active", active);
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
      const yearBar = e.target.closest("#chart-years [data-year]");
      if (yearBar) {
        drillDownYear(yearBar.dataset.year);
        return;
      }
      const card = e.target.closest("[data-drill]");
      if (card) drillDown(card.dataset.drill);
    });
    dashboard.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const yearBar = e.target.closest("#chart-years [data-year]");
      if (yearBar) {
        e.preventDefault();
        drillDownYear(yearBar.dataset.year);
        return;
      }
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

  function setFiltersOpen(open) {
    const sidebar = $("sidebar");
    const overlay = $("sidebar-overlay");
    const button = $("btn-filters");
    if (!sidebar) return;
    sidebar.classList.toggle("open", open);
    if (overlay) overlay.hidden = !open;
    if (button) button.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("filters-open", open);
    if (open) {
      const first = sidebar.querySelector("input, button, select");
      if (first) setTimeout(() => first.focus(), 60);
    }
  }

  function initFiltersDrawer() {
    const button = $("btn-filters");
    if (button) {
      button.addEventListener("click", () =>
        setFiltersOpen(!$("sidebar").classList.contains("open")),
      );
    }
    const close = $("btn-filters-close");
    if (close) close.addEventListener("click", () => setFiltersOpen(false));
    const overlay = $("sidebar-overlay");
    if (overlay) overlay.addEventListener("click", () => setFiltersOpen(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setFiltersOpen(false);
    });
    const desktop = window.matchMedia("(min-width: 769px)");
    const onChange = (e) => {
      if (e.matches) setFiltersOpen(false);
    };
    if (desktop.addEventListener) desktop.addEventListener("change", onChange);
    else desktop.addListener(onChange);
  }

  // Печать/PDF: три режима — сводный отчёт, только дашборд, только реестр.
  // Печатный макет A4-альбом собирается из существующей разметки, без библиотек.
  const PRINT_TITLES = {
    all: "сводный отчёт",
    dashboard: "дашборд",
    table: "реестр объектов",
  };
  const PRINT_CLASSES = [
    "printing-report",
    "print-mode-all",
    "print-mode-dashboard",
    "print-mode-table",
  ];

  function printReport(mode = "all") {
    const kind = PRINT_TITLES[mode] ? mode : "all";
    document.body.classList.add("printing-report", "print-mode-" + kind);
    const done = () => document.body.classList.remove(...PRINT_CLASSES);
    window.addEventListener("afterprint", done, { once: true });
    setTimeout(() => window.print(), 50);
  }

  function currentPrintMode() {
    const body = document.body;
    if (!body.classList.contains("printing-report")) return null;
    if (body.classList.contains("print-mode-dashboard")) return "dashboard";
    if (body.classList.contains("print-mode-table")) return "table";
    return "all";
  }

  function initPrint() {
    window.addEventListener("beforeprint", () => {
      const mode = currentPrintMode();
      const date = $("print-date");
      const count = $("print-count");
      const title = $("print-title");
      const filters = $("print-filters");
      const dataDate = $("print-data-date");
      const active = document.querySelector(".nav-btn.active");
      if (title) {
        title.textContent = `БОС · Аналитика — ${
          mode
            ? PRINT_TITLES[mode]
            : active
              ? active.textContent.trim()
              : "Реестр объектов"
        }`;
      }
      if (date) date.textContent = new Date().toLocaleString("ru-RU");
      if (count) {
        count.textContent = `${state.filteredData.length} ${plural(
          state.filteredData.length,
          ["строка", "строки", "строк"],
        )} из ${state.rawData.length}`;
      }
      if (filters) filters.textContent = describeFilters();
      if (dataDate) {
        dataDate.textContent = state.dataTs
          ? new Date(state.dataTs).toLocaleString("ru-RU")
          : "—";
      }
    });

    const menu = $("report-menu");
    if (!menu) return;
    menu.querySelectorAll("[data-print-mode]").forEach((item) => {
      item.addEventListener("click", () => {
        menu.open = false;
        printReport(item.dataset.printMode);
      });
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") menu.open = false;
    });
    document.addEventListener("click", (e) => {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
  }

  function startAutoRefresh() {
    if (!CONFIG.autoRefreshMs) return;
    setInterval(() => {
      if (document.visibilityState !== "visible" || state.loading) return;
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      loadData({ force: true, silent: true, auto: true });
    }, CONFIG.autoRefreshMs);
  }

  function applyDensity() {
    document.body.classList.toggle("table-compact", !!state.compact);
    const btn = $("btn-compact");
    if (btn) {
      btn.setAttribute("aria-pressed", state.compact ? "true" : "false");
      btn.title = state.compact
        ? "Обычная высота строк"
        : "Компактные строки: больше строк на экране";
    }
  }

  function initTableHandlers() {
    // Плотность строк: запоминается в настройках, печать не затрагивает.
    applyDensity();
    const density = $("btn-compact");
    if (density) {
      density.addEventListener("click", () => {
        state.compact = !state.compact;
        applyDensity();
        saveState();
      });
    }

    const head = $("main-table-head");
    if (head) {
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

    const search = $("table-search");
    if (search) {
      search.addEventListener(
        "input",
        debounce(() => setSearch(search.value), 200),
      );
    }

    const context = $("table-context");
    if (context) {
      context.addEventListener("click", (e) => {
        const clear = e.target.closest("[data-clear-filter]");
        if (clear) {
          setFilterAll(clear.dataset.clearFilter, true);
          return;
        }
        if (e.target.closest("[data-clear-search]")) {
          setSearch("");
          return;
        }
        if (e.target.closest("[data-reset-all]")) resetAllFilters();
      });
    }

    const reset = $("btn-reset-filters");
    if (reset) reset.addEventListener("click", resetAllFilters);
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
      if (e.target.closest("[data-map-key-save]")) {
        const input = $("map-key-input");
        const key = input ? input.value.trim() : "";
        if (!key) {
          if (input) input.focus();
          return;
        }
        try {
          localStorage.setItem(MAP_KEY_STORAGE, key);
        } catch {
          /* localStorage недоступен */
        }
        CONFIG.mapsApiKey = key;
        hideMapNotice();
        ensureMap();
        return;
      }
      if (!e.target.closest("[data-map-force]")) return;
      state.mapForceLoad = true;
      hideMapNotice();
      ensureMap();
    });
    notice.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.closest("#map-key-input")) return;
      e.preventDefault();
      notice.querySelector("[data-map-key-save]")?.click();
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
      state.pinned.add("obj");
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
    initTheme();
    initTabs();
    initHeader();
    initColumnsManager();
    initSidebar();
    initFiltersDrawer();
    initTableHandlers();
    initYearTableHandlers();
    initExport();
    initMapHandlers();
    initCompare();
    initPrint();
    initHash();
    if (window.BOS_DEBUG_HUD) window.BOS_DEBUG_HUD.init();
    loadData();
    startAutoRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
