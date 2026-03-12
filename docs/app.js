const STORAGE_KEY = "wos_jcr_catalog_v2";
const LEGACY_STORAGE_KEY = "wos_jcr_catalog_v1";
const STORAGE_META_KEY = "wos_jcr_catalog_meta_v1";
const CATALOG_DB_NAME = "wos_jcr_catalog_db";
const CATALOG_DB_VERSION = 1;
const CATALOG_STORE = "catalog";
const CATALOG_RECORD_KEY = "active";
const ORCID_REGEX = /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/i;
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
const VALIDATED_EDITIONS = new Set(["SCIE", "SSCI", "JCR_UNSPECIFIED"]);

const catalogForm = document.getElementById("catalog-form");
const catalogFileInput = document.getElementById("catalog-file");
const catalogStatus = document.getElementById("catalog-status");
const clearCatalogButton = document.getElementById("clear-catalog");

const researcherForm = document.getElementById("researcher-form");
const orcidInput = document.getElementById("orcid-input");
const researcherSubmit = document.getElementById("researcher-submit");
const message = document.getElementById("message");

const summarySection = document.getElementById("summary-section");
const summaryGrid = document.getElementById("summary-grid");
const tableSection = document.getElementById("table-section");
const resultsBody = document.getElementById("results-body");
const downloadPublicationsCsvButton = document.getElementById("download-publications-csv");
const downloadPublicationsXlsxButton = document.getElementById("download-publications-xlsx");
const diagnosticsSection = document.getElementById("diagnostics-section");
const diagnosticsBody = document.getElementById("diagnostics-body");
const downloadCsvButton = document.getElementById("download-csv");
const downloadJsonButton = document.getElementById("download-json");
const downloadDiagnosticsCsvButton = document.getElementById("download-diagnostics-csv");

let catalog = createEmptyCatalog();
let lastReport = null;

catalogForm.addEventListener("submit", onCatalogUpload);
clearCatalogButton.addEventListener("click", onClearCatalog);
researcherForm.addEventListener("submit", onGenerateReport);
downloadCsvButton.addEventListener("click", onDownloadCsv);
downloadJsonButton.addEventListener("click", onDownloadJson);
downloadPublicationsCsvButton.addEventListener("click", onDownloadPublicationsCsv);
downloadPublicationsXlsxButton.addEventListener("click", onDownloadPublicationsXlsx);
downloadDiagnosticsCsvButton.addEventListener("click", onDownloadDiagnosticsCsv);

init();

async function init() {
  await loadCatalogFromStorage();
  refreshCatalogStatus();
}

function createEmptyCatalog() {
  return {
    loaded: false,
    meta: null,
    journals: [],
    byName: new Map(),
    byIssn: new Map(),
    nameEntries: []
  };
}

function refreshCatalogStatus() {
  if (catalog.loaded) {
    const uploadedAt = catalog.meta?.uploadedAt ? new Date(catalog.meta.uploadedAt).toLocaleString() : "-";
    const fileName = catalog.meta?.sourceFileName || "-";
    catalogStatus.textContent = `Catalogo cargado localmente: SI | Revistas: ${catalog.journals.length} | Archivo: ${fileName} | Fecha: ${uploadedAt}`;
    researcherSubmit.disabled = false;
    return;
  }

  catalogStatus.textContent = "Catalogo cargado localmente: NO. Carga una vez tu archivo JCR/WoS.";
  researcherSubmit.disabled = true;
}

async function saveCatalogToStorage() {
  const serializable = {
    meta: catalog.meta,
    journals: catalog.journals
  };
  await idbSaveCatalog(serializable);
  try {
    localStorage.setItem(STORAGE_META_KEY, JSON.stringify(serializable.meta || null));
  } catch (_error) {
    // Ignore browser storage metadata errors.
  }
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

async function loadCatalogFromStorage() {
  try {
    const persisted = await idbLoadCatalog();
    if (persisted && Array.isArray(persisted.journals)) {
      catalog = buildRuntimeCatalog(persisted.journals, persisted.meta || null);
      return;
    }

    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    }
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.journals)) return;
    const sourceFile = String(parsed.meta?.sourceFileName || "").toLowerCase();
    const isLegacyPdfCatalog = sourceFile.endsWith(".pdf") && Number(parsed.meta?.parserVersion || 0) < 2;
    if (isLegacyPdfCatalog) return;

    catalog = buildRuntimeCatalog(parsed.journals, parsed.meta || null);
    await idbSaveCatalog({ meta: parsed.meta || null, journals: parsed.journals });
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (_error) {
    catalog = createEmptyCatalog();
  }
}

async function onClearCatalog() {
  await clearPersistedCatalog();
  catalog = createEmptyCatalog();
  lastReport = null;
  clearReport();
  refreshCatalogStatus();
  setMessage("Catalogo local eliminado.", false);
}

async function onCatalogUpload(event) {
  event.preventDefault();
  const file = catalogFileInput.files?.[0];

  if (!file) {
    setMessage("Selecciona un archivo de catalogo.", true);
    return;
  }

  disableDuring(catalogForm, true);
  setMessage("Procesando catalogo...", false);

  try {
    const extension = getFileExtension(file.name);
    let parsedRows = [];
    let sourceRows = 0;

    if (extension === "pdf") {
      parsedRows = await parsePdfCatalogRows(file);
      sourceRows = parsedRows.length;
    } else {
      if (typeof XLSX === "undefined") {
        throw new Error("No se pudo cargar el parser XLSX en el navegador.");
      }

      const tableRows = await parseTableFile(file);
      const headerIndex = detectHeaderIndex(tableRows);

      if (headerIndex < 0) {
        throw new Error("No se detecto cabecera valida. Debe incluir Journal name y columnas de indice/cuartil.");
      }

      const objects = toObjectsFromHeader(tableRows, headerIndex);
      parsedRows = objects.map(mapCatalogRow).filter((item) => item !== null);
      sourceRows = objects.length;
    }

    if (!parsedRows.length) {
      throw new Error("No se detectaron filas validas de revistas en el archivo.");
    }

    catalog = buildCatalog(parsedRows, {
      sourceFileName: file.name,
      sourceRows
    });

    await saveCatalogToStorage();
    refreshCatalogStatus();
    setMessage(`Catalogo cargado correctamente. Revistas: ${catalog.journals.length}.`, false);
  } catch (error) {
    setMessage(error.message || "Error al procesar el catalogo.", true);
  } finally {
    disableDuring(catalogForm, false);
  }
}

function openCatalogDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB no esta disponible en este navegador."));
      return;
    }

    const request = indexedDB.open(CATALOG_DB_NAME, CATALOG_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CATALOG_STORE)) {
        db.createObjectStore(CATALOG_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir IndexedDB."));
  });
}

async function idbSaveCatalog(payload) {
  const db = await openCatalogDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CATALOG_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("No se pudo guardar el catalogo en IndexedDB."));
    tx.objectStore(CATALOG_STORE).put(payload, CATALOG_RECORD_KEY);
  });
  db.close();
}

async function idbLoadCatalog() {
  const db = await openCatalogDb();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(CATALOG_STORE, "readonly");
    tx.onerror = () => reject(tx.error || new Error("No se pudo leer catalogo desde IndexedDB."));
    const req = tx.objectStore(CATALOG_STORE).get(CATALOG_RECORD_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("No se pudo leer registro de catalogo."));
  });
  db.close();
  return value;
}

async function idbClearCatalog() {
  const db = await openCatalogDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CATALOG_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("No se pudo limpiar catalogo en IndexedDB."));
    tx.objectStore(CATALOG_STORE).delete(CATALOG_RECORD_KEY);
  });
  db.close();
}

async function clearPersistedCatalog() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  localStorage.removeItem(STORAGE_META_KEY);
  try {
    await idbClearCatalog();
  } catch (_error) {
    // Ignore clean-up failures.
  }
}

async function onGenerateReport(event) {
  event.preventDefault();

  if (!catalog.loaded) {
    setMessage("Debes cargar primero un catalogo JCR/WoS.", true);
    return;
  }

  const rawOrcid = String(orcidInput.value || "").trim();
  const orcid = normalizeOrcid(rawOrcid);

  if (!orcid) {
    setMessage("ORCID invalido. Usa 0000-0000-0000-0000 o URL ORCID.", true);
    return;
  }

  disableDuring(researcherForm, true);
  clearReport();
  setMessage("Consultando ORCID y validando publicaciones...", false);

  try {
    const works = await fetchOrcidWorks(orcid);
    const report = buildResearchReport(orcid, works, catalog);

    lastReport = report;
    renderSummary(report);
    renderTable(report.publications);
    renderDiagnostics(report.diagnostics || []);
    setMessage("Reporte generado.", false);
  } catch (error) {
    setMessage(error.message || "No fue posible generar el reporte.", true);
  } finally {
    disableDuring(researcherForm, false);
  }
}

function renderSummary(report) {
  summarySection.classList.remove("hidden");

  const stats = report.stats || {};
  const cards = [
    ["ORCID", report.researcher?.orcid || "-"],
    ["Total publicaciones ORCID", stats.totalOrcidWorks ?? 0],
    ["Con revista informada", stats.worksWithJournalTitle ?? 0],
    ["Coinciden con catalogo", stats.worksMatchedInCatalog ?? 0],
    ["Validadas SCIE/SSCI", stats.validatedWorksSCIEorSSCI ?? 0],
    ["SCIE", stats.scieCount ?? 0],
    ["SSCI", stats.ssciCount ?? 0],
    ["Indice no especificado", stats.unspecifiedIndexCount ?? 0],
    ["Sin match catalogo", stats.noCatalogMatchCount ?? 0],
    ["Sin nombre revista ORCID", stats.noJournalNameCount ?? 0],
    ["Sin cuartil en catalogo", stats.noQuartileCount ?? 0],
    ["Tasa validacion", `${stats.validationRate ?? 0}%`],
    ["IF promedio", stats.averageImpactFactor ?? "-"],
    ["IF maximo", stats.maxImpactFactor ?? "-"],
    [
      "Distribucion cuartiles",
      `Q1:${stats.quartileDistribution?.Q1 ?? 0} Q2:${stats.quartileDistribution?.Q2 ?? 0} Q3:${stats.quartileDistribution?.Q3 ?? 0} Q4:${stats.quartileDistribution?.Q4 ?? 0} SinDato:${stats.quartileDistribution?.SinDato ?? 0}`
    ],
    [
      "Top areas",
      (stats.topBestQuartileAreas || []).map((item) => `${item.value} (${item.count})`).join(" | ") || "-"
    ],
    [
      "Top motivo descarte",
      (stats.diagnosticsByReason || []).map((item) => `${item.value} (${item.count})`).join(" | ") || "-"
    ]
  ];

  summaryGrid.innerHTML = "";
  cards.forEach(([label, value]) => {
    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = `<small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong>`;
    summaryGrid.appendChild(card);
  });
}

function renderTable(publications) {
  tableSection.classList.remove("hidden");
  resultsBody.innerHTML = "";

  if (!publications.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 11;
    td.textContent = "No se encontraron publicaciones validadas en SCIE/SSCI.";
    tr.appendChild(td);
    resultsBody.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();
  publications.forEach((item, index) => {
    const tr = document.createElement("tr");
    tr.appendChild(cell(index + 1));
    tr.appendChild(cell(item.title));
    tr.appendChild(cell(item.journal));
    tr.appendChild(cell(item.year || "-"));
    tr.appendChild(cell((item.editionLabels || item.editions || []).join(", ") || "-"));
    tr.appendChild(cell(item.impactFactor ?? "-"));
    tr.appendChild(cell(item.bestQuartile || "-"));
    tr.appendChild(cell(item.bestQuartileArea || "-"));
    tr.appendChild(cell((item.allQuartiles || []).join(", ") || "-"));
    tr.appendChild(cell(item.issn || "-"));
    tr.appendChild(cell(item.doi || "-"));
    fragment.appendChild(tr);
  });
  resultsBody.appendChild(fragment);
}

function renderDiagnostics(rows) {
  diagnosticsSection.classList.remove("hidden");
  diagnosticsBody.innerHTML = "";

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 12;
    td.textContent = "No hay diagnostico disponible.";
    tr.appendChild(td);
    diagnosticsBody.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();
  rows.forEach((item, index) => {
    const tr = document.createElement("tr");
    tr.appendChild(cell(index + 1));
    tr.appendChild(cell(item.statusLabel || "-"));
    tr.appendChild(cell(item.reasonLabel || "-"));
    tr.appendChild(cell(item.year || "-"));
    tr.appendChild(cell(item.title || "-"));
    tr.appendChild(cell(item.orcidJournal || "-"));
    tr.appendChild(cell(item.catalogJournal || "-"));
    tr.appendChild(cell(item.matchBy || "-"));
    tr.appendChild(cell(item.matchScore ?? "-"));
    tr.appendChild(cell((item.editionLabels || []).join(", ") || "-"));
    tr.appendChild(cell((item.orcidIssnCandidates || []).join(", ") || "-"));
    tr.appendChild(cell(item.doi || "-"));
    fragment.appendChild(tr);
  });
  diagnosticsBody.appendChild(fragment);
}

function clearReport() {
  summarySection.classList.add("hidden");
  tableSection.classList.add("hidden");
  diagnosticsSection.classList.add("hidden");
  summaryGrid.innerHTML = "";
  resultsBody.innerHTML = "";
  diagnosticsBody.innerHTML = "";
  lastReport = null;
}

function onDownloadCsv() {
  if (!lastReport) return;

  const header = Object.keys(buildPublicationExportRow({}, 1, lastReport.researcher.orcid));
  const lines = [header.map(csvEscape).join(",")];
  lastReport.publications.forEach((row, index) => {
    const values = Object.values(buildPublicationExportRow(row, index + 1, lastReport.researcher.orcid));
    lines.push(values.map(csvEscape).join(","));
  });

  const csvContent = `\uFEFF${lines.join("\n")}`;
  const fileName = `reporte_orcid_${lastReport.researcher.orcid.replace(/-/g, "")}.csv`;
  downloadBlob(csvContent, "text/csv;charset=utf-8", fileName);
}

function onDownloadPublicationsCsv() {
  onDownloadCsv();
}

function onDownloadPublicationsXlsx() {
  if (!lastReport) return;
  if (typeof XLSX === "undefined") {
    setMessage("No se pudo cargar el exportador Excel.", true);
    return;
  }

  const rows = lastReport.publications.map((row, index) =>
    buildPublicationExportRow(row, index + 1, lastReport.researcher?.orcid || "")
  );
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Publicaciones");
  const fileName = `publicaciones_orcid_${(lastReport.researcher?.orcid || "investigador").replace(/-/g, "")}.xlsx`;
  XLSX.writeFile(workbook, fileName);
}

function onDownloadJson() {
  if (!lastReport) return;

  const text = JSON.stringify(lastReport, null, 2);
  const fileName = `reporte_orcid_${lastReport.researcher.orcid.replace(/-/g, "")}.json`;
  downloadBlob(text, "application/json", fileName);
}

function onDownloadDiagnosticsCsv() {
  if (!lastReport) return;

  const header = [
    "N",
    "ORCID",
    "PutCode",
    "Estado",
    "Motivo",
    "Ano",
    "Titulo",
    "RevistaORCID",
    "RevistaCatalogo",
    "MatchPor",
    "ScoreMatch",
    "Indice",
    "ISSNORCID",
    "DOI"
  ];

  const lines = [header.map(csvEscape).join(",")];
  (lastReport.diagnostics || []).forEach((row, index) => {
    lines.push(
      [
        index + 1,
        lastReport.researcher?.orcid || "",
        row.putCode || "",
        row.statusLabel || "",
        row.reasonLabel || "",
        row.year || "",
        row.title || "",
        row.orcidJournal || "",
        row.catalogJournal || "",
        row.matchBy || "",
        row.matchScore ?? "",
        (row.editionLabels || []).join("|"),
        (row.orcidIssnCandidates || []).join("|"),
        row.doi || ""
      ]
        .map(csvEscape)
        .join(",")
    );
  });

  const csvContent = `\uFEFF${lines.join("\n")}`;
  const fileName = `diagnostico_orcid_${lastReport.researcher.orcid.replace(/-/g, "")}.csv`;
  downloadBlob(csvContent, "text/csv;charset=utf-8", fileName);
}

function buildPublicationExportRow(row, index, orcid) {
  return {
    N: index,
    ORCID: orcid || "",
    Titulo: row.title || "",
    Revista: row.journal || "",
    Ano: row.year || "",
    DOI: row.doi || "",
    Tipo: row.type || "",
    Indice: (row.editionLabels || row.editions || []).join("|"),
    ImpactFactor: row.impactFactor ?? "",
    MejorQuartil: row.bestQuartile || "",
    AreaMejorQuartil: row.bestQuartileArea || "",
    TodosQuartiles: (row.allQuartiles || []).join("|"),
    ISSN: row.issn || ""
  };
}

function downloadBlob(content, mimeType, fileName) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function parseTableFile(file) {
  const extension = getFileExtension(file.name);

  if (extension === "xls" || extension === "xlsx") {
    const buffer = await file.arrayBuffer();
    return parseSpreadsheetRows(buffer);
  }

  const text = (await file.text()).replace(/^\uFEFF/, "");
  const delimiters = [",", ";", "\t", "|"];
  let bestRows = [];

  for (const delimiter of delimiters) {
    const rows = parseDelimitedRows(text, delimiter);
    if (scoreRowsForCatalog(rows) > scoreRowsForCatalog(bestRows)) {
      bestRows = rows;
    }
  }

  if (bestRows.length) {
    return bestRows;
  }

  const buffer = await file.arrayBuffer();
  return parseSpreadsheetRows(buffer);
}

function getFileExtension(fileName) {
  return (String(fileName || "").split(".").pop() || "").toLowerCase();
}

function parseSpreadsheetRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "array", dense: true, raw: false });
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false
  });
}

function parseDelimitedRows(text, delimiter) {
  try {
    const workbook = XLSX.read(text, {
      type: "string",
      FS: delimiter,
      dense: true,
      raw: false
    });

    const sheetName = workbook.SheetNames?.[0];
    if (!sheetName) return [];

    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: false
    });
  } catch (_error) {
    return [];
  }
}

async function parsePdfCatalogRows(file) {
  if (typeof pdfjsLib === "undefined") {
    throw new Error("No se pudo cargar el parser PDF en el navegador.");
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

  const inferredYear = parseYear(file.name);
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const document = await loadingTask.promise;
  const parsedRows = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent({ normalizeWhitespace: true });
    const pageRows = extractPdfRowsFromPage(textContent.items || [], inferredYear);
    parsedRows.push(...pageRows);
  }

  const uniqueRows = dedupePdfRows(parsedRows);
  if (!uniqueRows.length) {
    throw new Error("No se detectaron filas validas en el PDF. Verifica que sea el formato JCR Impact Factor List.");
  }
  return uniqueRows;
}

function extractPdfRowsFromPage(items, inferredYear) {
  const byY = new Map();

  items.forEach((item) => {
    const text = compactSpaces(item?.str || "");
    if (!text) return;

    const x = Number(item?.transform?.[4] ?? 0);
    const y = Number(item?.transform?.[5] ?? 0);
    const yBucket = Math.round(y * 2) / 2;

    if (!byY.has(yBucket)) {
      byY.set(yBucket, []);
    }

    byY.get(yBucket).push({ text, x });
  });

  const rows = [];
  [...byY.keys()]
    .sort((a, b) => b - a)
    .forEach((yBucket) => {
      const entries = byY.get(yBucket).sort((left, right) => left.x - right.x);
      const columns = {
        rank: [],
        journal: [],
        issn: [],
        jif: [],
        quartile: []
      };

      entries.forEach((entry) => {
        if (entry.x < 85) {
          columns.rank.push(entry.text);
          return;
        }
        if (entry.x < 262) {
          columns.journal.push(entry.text);
          return;
        }
        if (entry.x < 420) {
          columns.issn.push(entry.text);
          return;
        }
        if (entry.x < 468) {
          columns.jif.push(entry.text);
          return;
        }
        columns.quartile.push(entry.text);
      });

      const row = parsePdfColumns(columns, inferredYear);
      if (row) rows.push(row);
    });

  return rows;
}

function parsePdfColumns(columns, inferredYear) {
  const quartile = parseQuartile(columns.quartile.join(" "));
  if (!quartile) return null;

  const impactFactor = parseImpactFactor(columns.jif.join(" "));
  if (!Number.isFinite(impactFactor)) return null;

  const rankText = compactSpaces(columns.rank.join(" "));
  let journalText = compactSpaces(columns.journal.join(" "));
  if (!journalText) return null;

  let rankAndTitle = compactSpaces(`${rankText} ${journalText}`);
  if (!rankAndTitle) rankAndTitle = journalText;

  const fromHeader = normalizeKey(journalText);
  if (fromHeader.includes("journal name") || fromHeader.includes("jcr impact factor list") || fromHeader === "rank") {
    return null;
  }

  let journalName = "";
  const withRank = rankAndTitle.match(/^(\d+)\s+(.+)$/);
  if (withRank) {
    journalName = compactSpaces(withRank[2]);
  } else {
    const fallback = journalText.match(/^(\d+)\s+(.+)$/);
    journalName = fallback ? compactSpaces(fallback[2]) : journalText;
  }

  if (!journalName) return null;
  journalName = cleanPdfJournalName(journalName);
  if (!journalName) return null;
  if (/^(jcr impact factor list|edited by)\b/i.test(journalName)) return null;

  return {
    journalName,
    issn: extractIssnList(columns.issn.join(" ")),
    edition: "JCR_UNSPECIFIED",
    category: "",
    quartile,
    impactFactor,
    jifYear: inferredYear || null
  };
}

function cleanPdfJournalName(value) {
  let out = compactSpaces(value);
  out = out.replace(/^\d+\s+/, "");
  out = out.replace(/\s+(Q[1-4])$/, "");
  out = out.replace(/\s+\d+(\.\d+)?$/, "");
  return compactSpaces(out);
}

function dedupePdfRows(rows) {
  const uniqueMap = new Map();

  rows.forEach((row) => {
    const key = [
      normalizeKey(row.journalName),
      row.issn.join("|"),
      row.impactFactor ?? "",
      row.quartile || "",
      row.jifYear || ""
    ].join("::");

    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, row);
    }
  });

  return [...uniqueMap.values()];
}

function scoreRowsForCatalog(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  let maxCols = 0;
  rows.forEach((row) => {
    if (Array.isArray(row)) {
      maxCols = Math.max(maxCols, row.length);
    }
  });
  return rows.length * maxCols;
}

function detectHeaderIndex(rows) {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;

    const normalized = row.map((cell) => normalizeKey(cell));
    const hasJournalName = normalized.some((cell) => cell === "journal name" || cell === "full journal title");
    const hasEdition = normalized.some((cell) => cell === "edition" || cell.includes("index"));
    const hasQuartile = normalized.some((cell) => cell.includes("quartile"));

    if (hasJournalName && (hasEdition || hasQuartile)) {
      return i;
    }
  }
  return -1;
}

function toObjectsFromHeader(rows, headerIndex) {
  const headers = (rows[headerIndex] || []).map((value, index) => {
    const text = String(value || "").trim();
    return text || `column_${index + 1}`;
  });

  const objects = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;

    const joined = row.map((cell) => String(cell || "").trim()).join("");
    if (!joined) continue;

    const obj = {};
    headers.forEach((header, idx) => {
      obj[header] = String(row[idx] || "").trim();
    });
    objects.push(obj);
  }
  return objects;
}

function mapCatalogRow(row) {
  const normalized = normalizeRow(row);

  const journalName = pickValue(normalized, [
    /^journal name$/,
    /^full journal title$/,
    /^source title$/,
    /^journal title$/,
    /^source$/,
    /^so$/
  ]);

  if (!journalName) {
    return null;
  }

  const edition = pickValue(normalized, [/^edition$/, /^web of science index$/, /^wos index$/, /^index$/]);
  const category = pickValue(normalized, [/^category$/, /^subject category$/, /^jcr category$/]);
  const quartile = pickValue(normalized, [/^jif quartile$/, /^quartile$/, /^journal quartile$/]).toUpperCase();

  const issnRaw = [
    pickValue(normalized, [/^issn$/, /^print issn$/, /^sn$/]),
    pickValue(normalized, [/^eissn$/, /^electronic issn$/, /^e issn$/]),
    pickValue(normalized, [/^issn\/eissn$/, /^issn eissn$/])
  ]
    .filter(Boolean)
    .join(" ");

  const jifField = pickJifField(normalized);
  const impactFactor = parseImpactFactor(jifField.value);
  const jifYear = parseYear(jifField.header) || parseYear(pickValue(normalized, [/^jcr year$/, /^jif year$/, /^year$/]));

  return {
    journalName: compactSpaces(journalName),
    issn: extractIssnList(issnRaw),
    edition: compactSpaces(edition).toUpperCase(),
    category: compactSpaces(category),
    quartile: parseQuartile(quartile),
    impactFactor,
    jifYear
  };
}

function normalizeRow(row) {
  const output = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    output[normalizeKey(key)] = compactSpaces(value);
  });
  return output;
}

function pickValue(normalizedRow, patterns) {
  const entries = Object.entries(normalizedRow || {});
  for (const pattern of patterns) {
    for (const [header, value] of entries) {
      if (!value) continue;
      if (pattern.test(header)) return value;
    }
  }
  return "";
}

function pickJifField(normalizedRow) {
  const entries = Object.entries(normalizedRow || {});
  let selected = { header: "", value: "" };

  for (const [header, value] of entries) {
    if (!value) continue;
    if (/quartile|jci/.test(header)) continue;

    if (/(^|\s)(\d{4}\s*)?jif($|\s)|impact factor/.test(header)) {
      selected = { header, value };
      if (/\d{4}/.test(header)) return selected;
    }
  }

  return selected;
}

function buildCatalog(parsedRows, sourceMeta) {
  const byName = new Map();

  parsedRows.forEach((row) => {
    const key = normalizeKey(row.journalName);
    if (!key) return;

    if (!byName.has(key)) {
      byName.set(key, {
        journalName: row.journalName,
        issnSet: new Set(),
        editionsSet: new Set(),
        metrics: []
      });
    }

    const journal = byName.get(key);
    row.issn.forEach((item) => journal.issnSet.add(item));
    splitEditions(row.edition).forEach((item) => journal.editionsSet.add(item));

    const metricKey = `${row.category}|${row.edition}|${row.quartile}|${row.jifYear}|${row.impactFactor}`;
    if (!journal.metrics.some((item) => item._key === metricKey)) {
      journal.metrics.push({
        _key: metricKey,
        category: row.category || null,
        edition: row.edition || null,
        quartile: row.quartile || null,
        impactFactor: row.impactFactor ?? null,
        jifYear: row.jifYear ?? null
      });
    }
  });

  const journals = [...byName.values()].map((item) => {
    const editions = [...item.editionsSet].sort();

    const metrics = item.metrics.map((metric) => ({
      category: metric.category,
      edition: metric.edition,
      quartile: metric.quartile,
      impactFactor: metric.impactFactor,
      jifYear: metric.jifYear
    }));

    const bestQuartile = chooseBestQuartile(metrics.map((metric) => metric.quartile));
    const bestAreas = uniq(
      metrics
        .filter((metric) => metric.quartile === bestQuartile && metric.category)
        .map((metric) => metric.category)
    );

    const allQuartiles = uniq(metrics.map((metric) => metric.quartile).filter(Boolean)).sort(sortQuartiles);

    const impactCandidates = metrics
      .map((metric) => Number(metric.impactFactor))
      .filter((value) => Number.isFinite(value));

    const latestJifYear = Math.max(
      ...metrics.map((metric) => (Number.isFinite(metric.jifYear) ? metric.jifYear : -Infinity))
    );

    return {
      journalName: item.journalName,
      issn: [...item.issnSet].sort(),
      editions,
      validatedInJcr: editions.some((edition) => isValidatedEdition(edition)),
      impactFactor: impactCandidates.length ? Math.max(...impactCandidates) : null,
      bestQuartile: bestQuartile || null,
      bestQuartileAreas: bestAreas,
      allQuartiles,
      jifYear: Number.isFinite(latestJifYear) ? latestJifYear : null,
      metrics
    };
  });

  journals.sort((a, b) => a.journalName.localeCompare(b.journalName, "en", { sensitivity: "base" }));

  const built = buildRuntimeCatalog(journals, {
    sourceFileName: sourceMeta.sourceFileName,
    sourceRows: sourceMeta.sourceRows,
    parsedRows: parsedRows.length,
    journalCount: journals.length,
    parserVersion: 2,
    uploadedAt: new Date().toISOString()
  });

  return built;
}

function buildRuntimeCatalog(journals, meta) {
  const byName = new Map();
  const byIssn = new Map();
  const nameEntries = [];

  journals.forEach((journal) => {
    const key = normalizeKey(journal.journalName);
    byName.set(key, journal);
    nameEntries.push({ key, tokens: tokenizeKey(key), journal });

    (journal.issn || []).forEach((issn) => {
      if (!byIssn.has(issn)) {
        byIssn.set(issn, []);
      }
      byIssn.get(issn).push(journal);
    });
  });

  return {
    loaded: true,
    meta,
    journals,
    byName,
    byIssn,
    nameEntries
  };
}

function normalizeOrcid(value) {
  const text = String(value || "").trim();
  const match = text.match(ORCID_REGEX);
  if (!match) return "";
  return match[0].toUpperCase();
}

async function fetchOrcidWorks(orcid) {
  const url = `https://pub.orcid.org/v3.0/${orcid}/works`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`No fue posible consultar ORCID (${response.status}).`);
  }

  const payload = await response.json();
  const groups = Array.isArray(payload.group) ? payload.group : [];
  const works = [];
  const seen = new Set();

  groups.forEach((group) => {
    const summaries = Array.isArray(group["work-summary"]) ? group["work-summary"] : [];

    summaries.forEach((summary) => {
      const putCode = summary["put-code"];
      if (seen.has(putCode)) return;
      seen.add(putCode);

      works.push({
        putCode,
        title: summary?.title?.title?.value || "",
        journalTitle: summary?.["journal-title"]?.value || "",
        year: parseYear(summary?.["publication-date"]?.year?.value),
        type: summary?.type || "",
        doi: extractExternalId(summary, "doi"),
        issnCandidates: extractIssnFromExternalIds(summary)
      });
    });
  });

  works.sort((a, b) => (b.year || 0) - (a.year || 0));
  return works;
}

function extractExternalId(summary, targetType) {
  const ids = summary?.["external-ids"]?.["external-id"];
  if (!Array.isArray(ids)) return "";

  const found = ids.find((item) => String(item?.["external-id-type"] || "").toLowerCase() === targetType);
  return found?.["external-id-value"] || "";
}

function extractIssnFromExternalIds(summary) {
  const ids = summary?.["external-ids"]?.["external-id"];
  if (!Array.isArray(ids)) return [];

  const out = [];
  ids.forEach((item) => {
    const type = String(item?.["external-id-type"] || "").toLowerCase();
    if (!type.includes("issn")) return;
    const value = String(item?.["external-id-value"] || "");
    extractIssnList(value).forEach((issn) => out.push(issn));
  });

  return uniq(out);
}

function buildResearchReport(orcid, works, currentCatalog) {
  const reportRows = [];
  const diagnostics = [];
  let matchedCatalogCount = 0;

  works.forEach((work) => {
    const match = matchJournalDetails(work, currentCatalog);
    const journal = match.journal;
    if (journal) {
      matchedCatalogCount += 1;
    }

    const editions = journal ? (journal.editions || []).filter((edition) => isValidatedEdition(edition)) : [];
    const editionLabels = editions.map((edition) => formatEditionLabel(edition));
    const hasQuartile =
      Boolean(journal?.bestQuartile) || (Array.isArray(journal?.allQuartiles) && journal.allQuartiles.length > 0);

    let status = "EXCLUIDA";
    let reason = "NO_CATALOG_MATCH";
    if (!work.journalTitle) {
      reason = "NO_JOURNAL_NAME";
    } else if (journal && !journal.validatedInJcr) {
      reason = "MATCHED_NOT_VALIDATED";
    } else if (journal && !hasQuartile) {
      reason = "MATCHED_NO_QUARTILE";
    } else if (journal && !editions.length) {
      reason = "MATCHED_NO_ALLOWED_INDEX";
    } else if (journal && editions.length) {
      status = "INCLUIDA";
      reason = "VALIDATED_INCLUDED";
    }

    diagnostics.push({
      putCode: work.putCode || "",
      status,
      statusLabel: status === "INCLUIDA" ? "Incluida" : "Excluida",
      reason,
      reasonLabel: reasonToLabel(reason),
      title: work.title || "Sin titulo",
      year: work.year || null,
      doi: work.doi || null,
      orcidJournal: work.journalTitle || "",
      orcidIssnCandidates: work.issnCandidates || [],
      catalogJournal: journal?.journalName || "",
      matchBy: match.matchByLabel || "",
      matchScore: Number.isFinite(match.matchScore) ? Number(match.matchScore.toFixed(3)) : null,
      editions,
      editionLabels
    });

    if (status === "INCLUIDA") {
      const bestQuartileArea =
        (journal.bestQuartileAreas || []).join(" | ") || "No disponible en este formato de catalogo";
      reportRows.push({
        title: work.title || "Sin titulo",
        journal: work.journalTitle || journal.journalName,
        year: work.year || null,
        doi: work.doi || null,
        type: work.type || null,
        editions,
        editionLabels,
        impactFactor: journal.impactFactor,
        bestQuartile: journal.bestQuartile,
        bestQuartileArea,
        allQuartiles: journal.allQuartiles || [],
        issn: (journal.issn || []).join(", ")
      });
    }
  });

  const scieCount = reportRows.filter((row) => row.editions.includes("SCIE")).length;
  const ssciCount = reportRows.filter((row) => row.editions.includes("SSCI")).length;
  const unspecifiedIndexCount = reportRows.filter((row) => row.editions.includes("JCR_UNSPECIFIED")).length;
  const noCatalogMatchCount = diagnostics.filter((row) => row.reason === "NO_CATALOG_MATCH").length;
  const noJournalNameCount = diagnostics.filter((row) => row.reason === "NO_JOURNAL_NAME").length;
  const noQuartileCount = diagnostics.filter((row) => row.reason === "MATCHED_NO_QUARTILE").length;
  const diagnosticsByReason = topCounts(
    diagnostics.map((row) => row.reasonLabel).filter(Boolean),
    20
  );

  const quartileDistribution = { Q1: 0, Q2: 0, Q3: 0, Q4: 0, SinDato: 0 };
  reportRows.forEach((row) => {
    if (row.bestQuartile && quartileDistribution[row.bestQuartile] !== undefined) {
      quartileDistribution[row.bestQuartile] += 1;
    } else {
      quartileDistribution.SinDato += 1;
    }
  });

  const ifValues = reportRows
    .map((row) => Number(row.impactFactor))
    .filter((value) => Number.isFinite(value));

  const topAreas = topCounts(
    reportRows
      .flatMap((row) => String(row.bestQuartileArea || "").split("|"))
      .map((value) => compactSpaces(value))
      .filter(Boolean),
    10
  );

  return {
    generatedAt: new Date().toISOString(),
    researcher: { orcid },
    catalogMeta: currentCatalog.meta,
    stats: {
      totalOrcidWorks: works.length,
      worksWithJournalTitle: works.filter((work) => Boolean(work.journalTitle)).length,
      worksMatchedInCatalog: matchedCatalogCount,
      validatedWorksSCIEorSSCI: reportRows.length,
      scieCount,
      ssciCount,
      unspecifiedIndexCount,
      noCatalogMatchCount,
      noJournalNameCount,
      noQuartileCount,
      diagnosticsByReason,
      validationRate: works.length ? Number(((reportRows.length / works.length) * 100).toFixed(2)) : 0,
      averageImpactFactor: ifValues.length ? Number((sum(ifValues) / ifValues.length).toFixed(3)) : null,
      maxImpactFactor: ifValues.length ? Math.max(...ifValues) : null,
      quartileDistribution,
      topBestQuartileAreas: topAreas
    },
    publications: reportRows,
    diagnostics
  };
}

function matchJournalDetails(work, currentCatalog) {
  const workJournalKey = normalizeKey(work.journalTitle);
  if (!workJournalKey) {
    return {
      journal: null,
      matchBy: "",
      matchByLabel: "",
      matchScore: null,
      candidateCount: 0
    };
  }

  const candidates = findApproximateJournalMatches(workJournalKey, currentCatalog);
  if (!candidates.length) {
    return {
      journal: null,
      matchBy: "",
      matchByLabel: "",
      matchScore: null,
      candidateCount: 0
    };
  }

  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreJournalCandidate(candidate.journal, workJournalKey) + candidate.similarity * 1000
    }))
    .sort((left, right) => right.score - left.score);

  const best = ranked[0];
  return {
    journal: best.journal,
    matchBy: "name_approx",
    matchByLabel: matchByToLabel("name_approx"),
    matchScore: best.similarity,
    candidateCount: candidates.length
  };
}

function matchByToLabel(matchBy) {
  if (matchBy === "name_approx") return "Nombre aproximado";
  return "";
}

function reasonToLabel(reason) {
  if (reason === "VALIDATED_INCLUDED") return "Incluida: validada en catalogo";
  if (reason === "NO_CATALOG_MATCH") return "Excluida: sin coincidencia en catalogo";
  if (reason === "NO_JOURNAL_NAME") return "Excluida: ORCID sin nombre de revista";
  if (reason === "MATCHED_NOT_VALIDATED") return "Excluida: revista no validada";
  if (reason === "MATCHED_NO_QUARTILE") return "Excluida: revista sin cuartil";
  if (reason === "MATCHED_NO_ALLOWED_INDEX") return "Excluida: indice no permitido";
  return reason || "Sin detalle";
}

function findApproximateJournalMatches(workJournalKey, currentCatalog) {
  const out = [];
  const workTokens = tokenizeKey(workJournalKey);
  if (!workTokens.length) return out;

  (currentCatalog.nameEntries || []).forEach((entry) => {
    if (!entry?.key || !entry?.tokens?.length || !entry?.journal) return;
    const similarity = computeApproxSimilarity(workJournalKey, workTokens, entry.key, entry.tokens);
    if (similarity < 0.6) return;
    out.push({ journal: entry.journal, similarity });
  });

  return out
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 40);
}

function computeApproxSimilarity(workKey, workTokens, candidateKey, candidateTokens) {
  const workSet = new Set(workTokens);
  const candidateSet = new Set(candidateTokens);
  let intersection = 0;

  workSet.forEach((token) => {
    if (candidateSet.has(token)) intersection += 1;
  });

  const unionSize = new Set([...workSet, ...candidateSet]).size || 1;
  const jaccard = intersection / unionSize;
  const containment = intersection / (workSet.size || 1);
  const substringBoost = candidateKey.includes(workKey) || workKey.includes(candidateKey) ? 0.2 : 0;
  return Math.min(1, jaccard * 0.65 + containment * 0.35 + substringBoost);
}

function scoreJournalCandidate(journal, workJournalKey = "") {
  const journalKey = normalizeKey(journal.journalName);
  const validated = journal.validatedInJcr ? 100000 : 0;
  const qScore = quartileScore(journal.bestQuartile);
  const ifScore = Number.isFinite(Number(journal.impactFactor)) ? Number(journal.impactFactor) : 0;
  const containsScore =
    workJournalKey && (journalKey.includes(workJournalKey) || workJournalKey.includes(journalKey)) ? 500 : 0;
  const distancePenalty = workJournalKey ? Math.abs(journalKey.length - workJournalKey.length) * 0.2 : 0;
  return validated + qScore * 100 + ifScore + containsScore - distancePenalty;
}

function quartileScore(quartile) {
  const map = { Q1: 4, Q2: 3, Q3: 2, Q4: 1 };
  return map[String(quartile || "").toUpperCase()] || 0;
}

function parseImpactFactor(value) {
  const text = compactSpaces(value).replace(",", ".");
  if (!text) return null;

  const match = text.match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseQuartile(value) {
  const match = String(value || "").toUpperCase().match(/\bQ[1-4]\b/);
  return match ? match[0] : "";
}

function parseYear(value) {
  const match = String(value || "").match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function isValidatedEdition(edition) {
  return VALIDATED_EDITIONS.has(String(edition || "").toUpperCase());
}

function formatEditionLabel(edition) {
  const normalized = String(edition || "").toUpperCase();
  if (normalized === "JCR_UNSPECIFIED") {
    return "SCIE/SSCI (no especificado en catalogo PDF)";
  }
  return normalized;
}

function splitEditions(value) {
  return uniq(
    String(value || "")
      .split(/[;,/|]+/)
      .map((item) => compactSpaces(item).toUpperCase())
      .filter(Boolean)
  );
}

function extractIssnList(value) {
  const matches = String(value || "").toUpperCase().match(/[0-9]{4}-[0-9]{3}[0-9X]/g) || [];
  return uniq(matches);
}

function chooseBestQuartile(values) {
  const order = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };

  const valid = values
    .map((value) => String(value || "").toUpperCase())
    .filter((value) => Object.prototype.hasOwnProperty.call(order, value));

  if (!valid.length) return "";

  return valid.sort((a, b) => order[a] - order[b])[0];
}

function sortQuartiles(a, b) {
  const order = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
  const left = order[String(a || "").toUpperCase()] || 99;
  const right = order[String(b || "").toUpperCase()] || 99;
  return left - right;
}

function topCounts(values, limit) {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeKey(value) {
  return normalizeKey(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function compactSpaces(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(values) {
  return [...new Set(values)];
}

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function disableDuring(formElement, value) {
  formElement.querySelectorAll("button, input").forEach((element) => {
    element.disabled = value;
  });
}

function setMessage(text, isError) {
  message.textContent = text || "";
  message.classList.toggle("error", Boolean(isError));
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function cell(value) {
  const td = document.createElement("td");
  td.textContent = String(value);
  return td;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
