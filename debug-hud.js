/* БОС · Аналитика — диагностический оверлей производительности (?debug=1). */
(() => {
  "use strict";

  function initDebugHud() {
    if (!/[?&]debug=1(?:&|$)/.test(location.search)) return;

    const hud = document.createElement("div");
    hud.className = "perf-hud";
    hud.setAttribute("role", "status");
    hud.setAttribute("aria-live", "off");
    document.body.appendChild(hud);

    const s = {
      frames: 0,
      since: performance.now(),
      fps: 0,
      worstFrame: 0,
      lastFrame: performance.now(),
      longTasks: 0,
      longTaskMax: 0,
      hides: 0,
      tiles: 0,
      tileSum: 0,
      tileMax: 0,
      tileSlow: 0,
    };

    const frameTick = (now) => {
      s.frames += 1;
      s.worstFrame = Math.max(s.worstFrame, now - s.lastFrame);
      s.lastFrame = now;
      if (now - s.since >= 1000) {
        s.fps = Math.round((s.frames * 1000) / (now - s.since));
        s.frames = 0;
        s.since = now;
      }
      requestAnimationFrame(frameTick);
    };
    requestAnimationFrame(frameTick);

    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          s.longTasks += 1;
          s.longTaskMax = Math.max(s.longTaskMax, e.duration);
        });
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* API нет */
    }

    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          if (!/tiles/.test(e.name)) return;
          s.tiles += 1;
          s.tileSum += e.duration;
          s.tileMax = Math.max(s.tileMax, e.duration);
          if (e.duration > 500) s.tileSlow += 1;
        });
      }).observe({ type: "resource", buffered: true });
    } catch {
      /* API нет */
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) s.hides += 1;
    });

    const paint = () => {
      const tileAvg = s.tiles ? Math.round(s.tileSum / s.tiles) : 0;
      const heap = performance.memory
        ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} МБ`
        : "—";
      const canvas = document.querySelector("#map canvas");
      const href =
        Array.from(document.querySelectorAll("#map a"))
          .map((a) => a.href)
          .find((h) => /[?&]ll=/.test(h)) || "";
      const pos = href.match(/ll=([\d.-]+),([\d.-]+)&z=(\d+)/);
      hud.textContent = [
        `fps ${s.fps} · худший кадр ${Math.round(s.worstFrame)} мс`,
        `длинных задач ${s.longTasks} (макс ${Math.round(s.longTaskMax)} мс)`,
        `тайлы ${s.tiles} · сред ${tileAvg} мс · макс ${Math.round(s.tileMax)} мс · >500 мс ${s.tileSlow}`,
        `heap ${heap} · узлов ${document.querySelectorAll("*").length} · dpr ${window.devicePixelRatio}`,
        `экран ${screen.width}×${screen.height} · окно ${innerWidth}×${innerHeight} · уходов в фон ${s.hides}`,
        canvas ? `canvas ${canvas.width}×${canvas.height}` : "карта не инициализирована",
        `маркеров ${document.querySelectorAll("#map ymaps.ymaps-2-1-79-image").length}` +
          (pos ? ` · zoom ${pos[3]}` : ""),
        navigator.onLine ? "сеть: online" : "сеть: offline",
      ].join("\n");
    };
    paint();
    setInterval(paint, 500);
  }

  window.BOS_DEBUG_HUD = { init: initDebugHud };
})();
