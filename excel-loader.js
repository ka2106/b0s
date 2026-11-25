/* БОС · Аналитика — ленивая загрузка ExcelJS (около 1 МБ, нужна только
   для экспорта и сравнения файлов). */
(() => {
  "use strict";

  // ExcelJS (~1 МБ) грузится по требованию: только для экспорта и сравнения.
  const EXCELJS_SRC =
    "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const EXCELJS_SRI =
    "sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz";
  let excelJsPromise = null;

  function ensureExcelJs() {
    if (typeof ExcelJS !== "undefined") return Promise.resolve(ExcelJS);
    if (excelJsPromise) return excelJsPromise;
    excelJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = EXCELJS_SRC;
      script.integrity = EXCELJS_SRI;
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      script.onload = () => {
        if (typeof ExcelJS === "undefined") {
          reject(new Error("ExcelJS не инициализировался"));
        } else {
          resolve(ExcelJS);
        }
      };
      script.onerror = () => {
        excelJsPromise = null;
        script.remove();
        reject(new Error("не удалось загрузить ExcelJS (проверьте сеть)"));
      };
      document.head.appendChild(script);
    });
    return excelJsPromise;
  }

  window.BOS_EXCEL = { load: ensureExcelJs };
})();
