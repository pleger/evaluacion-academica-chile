const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const multer = require("multer");
const XLSX = require("xlsx");
const { parse: parseCsv } = require("csv-parse/sync");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const DATA_DIR = path.join(__dirname, "data");
const CATALOG_PATH = path.join(DATA_DIR, "catalog.json");
const ORCID_REGEX = /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/i;
const VALIDATED_EDITIONS = new Set(["SCIE", "SSCI", "JCR_UNSPECIFIED"]);

let catalog = createEmptyCatalog();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    catalogLoaded: catalog.loaded,
    journalCount: catalog.journals.length
  });
});

app.get("/api/catalog/status", (_req, res) => {
  res.json({
    loaded: catalog.loaded,
    meta: catalog.meta,
    journalCount: catalog.journals.length
  });
});

app.post("/api/catalog/upload", upload.single("catalogFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Debes adjuntar un archivo de catalogo JCR/WoS." });
    }

    const extension = path.extname(req.file.originalname || "").toLowerCase();
    let parsedRows = [];
    let sourceRows = 0;

    if (extension === ".pdf") {
      parsedRows = parsePdfCatalogRows(req.file.buffer, req.file.originalname);
      sourceRows = parsedRows.length;
    } else {
      const tableRows = parseTableFile(req.file);
      const headerIndex = detectHeaderIndex(tableRows);
      if (headerIndex < 0) {
        return res.status(400).json({
          error: "No se detecto la fila de cabecera del catalogo. Verifica que incluya 'Journal name'."
        });
      }

      const objects = toObjectsFromHeader(tableRows, headerIndex);
      parsedRows = objects.map(mapCatalogRow).filter((item) => item !== null);
      sourceRows = objects.length;
    }

    if (!parsedRows.length) {
      return res.status(400).json({
        error: "No se detectaron filas validas de revistas en el archivo."
      });
    }

    catalog = buildCatalog(parsedRows, {
      sourceFileName: req.file.originalname,
      sourceRows
    });
    persistCatalog(catalog);

    return res.json({
      ok: true,
      message: "Catalogo cargado correctamente.",
      meta: catalog.meta,
      journalCount: catalog.journals.length
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Error al procesar el catalogo."
    });
  }
});

app.get("/api/researcher/report", async (req, res) => {
  try {
    if (!catalog.loaded) {
      return res.status(400).json({
        error: "No hay catalogo JCR/WoS cargado. Carga primero el archivo de revistas."
      });
    }

    const rawOrcid = String(req.query.orcid || "").trim();
    const orcid = normalizeOrcid(rawOrcid);
    if (!orcid) {
      return res.status(400).json({
        error: "ORCID invalido. Usa formato 0000-0000-0000-0000 o URL de ORCID."
      });
    }

    const works = await fetchOrcidWorks(orcid);
    const report = buildResearchReport(orcid, works, catalog);
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Error al generar el reporte."
    });
  }
});

app.get("/api/researcher/report.csv", async (req, res) => {
  try {
    if (!catalog.loaded) {
      return res.status(400).json({
        error: "No hay catalogo JCR/WoS cargado."
      });
    }

    const rawOrcid = String(req.query.orcid || "").trim();
    const orcid = normalizeOrcid(rawOrcid);
    if (!orcid) {
      return res.status(400).json({
        error: "ORCID invalido."
      });
    }

    const works = await fetchOrcidWorks(orcid);
    const report = buildResearchReport(orcid, works, catalog);
    const csv = createCsvReport(report);

    const fileName = `reporte_orcid_${orcid.replace(/-/g, "")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(`\uFEFF${csv}`);
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Error al exportar CSV."
    });
  }
});

function createEmptyCatalog() {
  return {
    loaded: false,
    meta: null,
    journals: [],
    byName: new Map()
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persistCatalog(value) {
  ensureDataDir();
  const serializable = {
    meta: value.meta,
    journals: value.journals
  };
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(serializable, null, 2), "utf8");
}

function loadCatalogFromDisk() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    if (!parsed || !Array.isArray(parsed.journals)) return;

    const byName = new Map();
    for (const journal of parsed.journals) {
      byName.set(normalizeKey(journal.journalName), journal);
    }

    catalog = {
      loaded: true,
      meta: parsed.meta || null,
      journals: parsed.journals,
      byName
    };
  } catch (_error) {
    catalog = createEmptyCatalog();
  }
}

function parseTableFile(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (extension === ".xls" || extension === ".xlsx") {
    return parseSpreadsheetRows(file.buffer);
  }
  return parseDelimitedRows(file.buffer);
}

function parseSpreadsheetRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", dense: true });
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false
  });
}

function parseDelimitedRows(buffer) {
  const rawText = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const delimiters = [",", ";", "\t", "|"];
  let best = [];

  for (const delimiter of delimiters) {
    try {
      const rows = parseCsv(rawText, {
        delimiter,
        relax_quotes: true,
        relax_column_count: true,
        skip_empty_lines: false,
        bom: true
      });
      if (!rows.length) continue;
      if (scoreRowsForCatalog(rows) > scoreRowsForCatalog(best)) best = rows;
    } catch (_error) {
      // Try next delimiter.
    }
  }

  return best;
}

function parsePdfCatalogRows(pdfBuffer, originalName) {
  const tempPath = path.join(
    os.tmpdir(),
    `jcr_catalog_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`
  );

  let text = "";
  try {
    fs.writeFileSync(tempPath, pdfBuffer);
    text = execFileSync("pdftotext", ["-layout", tempPath, "-"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024
    });
  } catch (_error) {
    throw new Error("No se pudo leer el PDF. Verifica que pdftotext este disponible y el archivo sea valido.");
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_error) {
      // Ignore temp cleanup errors.
    }
  }

  const inferredYear = parseYear(originalName) || parseYear(text.slice(0, 2000));
  const rows = [];

  for (const line of text.split(/\r?\n/)) {
    const parsed = parsePdfCatalogLine(line, inferredYear);
    if (parsed) rows.push(parsed);
  }

  return dedupePdfRows(rows);
}

function parsePdfCatalogLine(line, inferredYear) {
  const raw = String(line || "").replace(/\u00a0/g, " ").trim();
  if (!raw) return null;
  if (!/^\d/.test(raw)) return null;
  if (/^(\d+\s+)?(rank|journal name|publisher|issn|jif|quartile)\b/i.test(raw)) return null;

  const segments = raw
    .split(/\s{2,}/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (segments.length < 4) return null;

  const quartile = parseQuartile(segments[segments.length - 1]);
  if (!quartile) return null;

  const impactFactor = parseImpactFactor(segments[segments.length - 2]);
  if (!Number.isFinite(impactFactor)) return null;

  const issnValue = extractIssn(segments[segments.length - 3]);
  const left = segments.slice(0, -3);
  if (!left.length) return null;

  let rankAndTitle = left[0];
  if (/^\d+$/.test(rankAndTitle)) {
    if (!left[1]) return null;
    rankAndTitle = `${rankAndTitle} ${left[1]}`;
  }

  const match = rankAndTitle.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;

  const journalName = compactSpaces(match[2]);
  if (!journalName) return null;
  if (/^(jcr impact factor list|edited by)\b/i.test(journalName)) return null;

  return {
    journalName,
    issn: issnValue,
    edition: "JCR_UNSPECIFIED",
    category: "",
    quartile,
    impactFactor,
    jifYear: inferredYear || null
  };
}

function dedupePdfRows(rows) {
  const uniqueMap = new Map();

  for (const row of rows) {
    const key = [
      normalizeKey(row.journalName),
      row.issn || "",
      row.impactFactor ?? "",
      row.quartile || "",
      row.jifYear || ""
    ].join("::");

    if (!uniqueMap.has(key)) uniqueMap.set(key, row);
  }

  return [...uniqueMap.values()];
}

function scoreRowsForCatalog(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  let maxCols = 0;
  for (const row of rows) {
    if (Array.isArray(row)) maxCols = Math.max(maxCols, row.length);
  }
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
    if (hasJournalName && (hasEdition || hasQuartile)) return i;
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
  if (!journalName) return null;

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
    issn: extractIssn(issnRaw),
    edition: compactSpaces(edition).toUpperCase(),
    category: compactSpaces(category),
    quartile: parseQuartile(quartile),
    impactFactor,
    jifYear
  };
}

function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    out[normalizeKey(key)] = compactSpaces(value);
  }
  return out;
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

  for (const row of parsedRows) {
    const key = normalizeKey(row.journalName);
    if (!key) continue;

    if (!byName.has(key)) {
      byName.set(key, {
        journalName: row.journalName,
        issnSet: new Set(),
        editionsSet: new Set(),
        metrics: []
      });
    }

    const journal = byName.get(key);
    if (row.issn) journal.issnSet.add(row.issn);

    for (const edition of splitEditions(row.edition)) {
      journal.editionsSet.add(edition);
    }

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
  }

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

    const impactCandidates = metrics
      .map((metric) => Number(metric.impactFactor))
      .filter((value) => Number.isFinite(value));

    const latestJifYear = Math.max(
      ...metrics.map((metric) => (Number.isFinite(metric.jifYear) ? metric.jifYear : -Infinity))
    );

    const validated = editions.some((edition) => isValidatedEdition(edition));

    return {
      journalName: item.journalName,
      issn: [...item.issnSet].sort(),
      editions,
      validatedInJcr: validated,
      impactFactor: impactCandidates.length ? Math.max(...impactCandidates) : null,
      bestQuartile: bestQuartile || null,
      bestQuartileAreas: bestAreas,
      jifYear: Number.isFinite(latestJifYear) ? latestJifYear : null,
      metrics
    };
  });

  journals.sort((a, b) => a.journalName.localeCompare(b.journalName, "en", { sensitivity: "base" }));

  const runtimeIndex = new Map();
  for (const journal of journals) {
    runtimeIndex.set(normalizeKey(journal.journalName), journal);
  }

  return {
    loaded: true,
    meta: {
      sourceFileName: sourceMeta.sourceFileName,
      sourceRows: sourceMeta.sourceRows,
      parsedRows: parsedRows.length,
      journalCount: journals.length,
      uploadedAt: new Date().toISOString()
    },
    journals,
    byName: runtimeIndex
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

  for (const group of groups) {
    const summaries = Array.isArray(group["work-summary"]) ? group["work-summary"] : [];
    for (const summary of summaries) {
      const putCode = summary["put-code"];
      if (seen.has(putCode)) continue;
      seen.add(putCode);

      works.push({
        putCode,
        title: summary?.title?.title?.value || "",
        journalTitle: summary?.["journal-title"]?.value || "",
        year: parseYear(summary?.["publication-date"]?.year?.value),
        type: summary?.type || "",
        doi: extractExternalId(summary, "doi")
      });
    }
  }

  works.sort((a, b) => (b.year || 0) - (a.year || 0));
  return works;
}

function extractExternalId(summary, targetType) {
  const ids = summary?.["external-ids"]?.["external-id"];
  if (!Array.isArray(ids)) return "";
  const found = ids.find((item) => String(item?.["external-id-type"] || "").toLowerCase() === targetType);
  return found?.["external-id-value"] || "";
}

function buildResearchReport(orcid, works, currentCatalog) {
  const reportRows = [];
  let matchedCatalogCount = 0;

  for (const work of works) {
    const journal = currentCatalog.byName.get(normalizeKey(work.journalTitle));
    if (journal) matchedCatalogCount += 1;
    if (!journal || !journal.validatedInJcr) continue;

    const editions = journal.editions.filter((edition) => isValidatedEdition(edition));
    if (!editions.length) continue;
    const editionLabels = editions.map((edition) => formatEditionLabel(edition));
    const bestQuartileArea = journal.bestQuartileAreas.join(" | ") || "No disponible en este formato de catalogo";

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
      allQuartiles: uniq(journal.metrics.map((metric) => metric.quartile).filter(Boolean)),
      issn: journal.issn.join(", ")
    });
  }

  const uniqueReportRows = dedupePublicationRows(reportRows);

  const scieCount = uniqueReportRows.filter((row) => row.editions.includes("SCIE")).length;
  const ssciCount = uniqueReportRows.filter((row) => row.editions.includes("SSCI")).length;
  const unspecifiedIndexCount = uniqueReportRows.filter((row) => row.editions.includes("JCR_UNSPECIFIED")).length;

  const quartileDistribution = { Q1: 0, Q2: 0, Q3: 0, Q4: 0, SinDato: 0 };
  uniqueReportRows.forEach((row) => {
    if (row.bestQuartile && quartileDistribution[row.bestQuartile] !== undefined) {
      quartileDistribution[row.bestQuartile] += 1;
    } else {
      quartileDistribution.SinDato += 1;
    }
  });

  const ifValues = uniqueReportRows
    .map((row) => Number(row.impactFactor))
    .filter((value) => Number.isFinite(value));

  const topAreas = topCounts(
    uniqueReportRows
      .flatMap((row) => String(row.bestQuartileArea || "").split("|"))
      .map((value) => compactSpaces(value))
      .filter(Boolean),
    10
  );

  return {
    generatedAt: new Date().toISOString(),
    researcher: {
      orcid
    },
    catalogMeta: currentCatalog.meta,
    stats: {
      totalOrcidWorks: works.length,
      worksWithJournalTitle: works.filter((work) => Boolean(work.journalTitle)).length,
      worksMatchedInCatalog: matchedCatalogCount,
      validatedWorksSCIEorSSCI: uniqueReportRows.length,
      scieCount,
      ssciCount,
      unspecifiedIndexCount,
      validationRate: works.length ? Number(((uniqueReportRows.length / works.length) * 100).toFixed(2)) : 0,
      averageImpactFactor: ifValues.length ? Number((sum(ifValues) / ifValues.length).toFixed(3)) : null,
      maxImpactFactor: ifValues.length ? Math.max(...ifValues) : null,
      quartileDistribution,
      topBestQuartileAreas: topAreas
    },
    publications: uniqueReportRows
  };
}

function dedupePublicationRows(rows) {
  const bestByKey = new Map();

  for (const row of rows) {
    const key = publicationUniqueKey(row);
    if (!key) continue;

    if (!bestByKey.has(key)) {
      bestByKey.set(key, row);
      continue;
    }

    const current = bestByKey.get(key);
    const currentIf = Number(current.impactFactor) || 0;
    const rowIf = Number(row.impactFactor) || 0;
    if (rowIf > currentIf) {
      bestByKey.set(key, row);
    }
  }

  return [...bestByKey.values()].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
}

function publicationUniqueKey(row) {
  const doi = normalizeDoi(row?.doi);
  if (doi) return `doi:${doi}`;

  const title = normalizeKey(row?.title);
  const journal = normalizeKey(row?.journal);
  const year = String(row?.year || "");
  if (!title && !journal && !year) return "";
  return `fallback:${title}|${journal}|${year}`;
}

function normalizeDoi(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
}

function createCsvReport(report) {
  const header = [
    "ORCID",
    "Titulo",
    "Revista",
    "Ano",
    "DOI",
    "Tipo",
    "Indice",
    "ImpactFactor",
    "MejorQuartil",
    "AreaMejorQuartil",
    "TodosQuartiles",
    "ISSN"
  ];

  const lines = [header.map(csvEscape).join(",")];
  for (const row of report.publications) {
    const values = [
      report.researcher.orcid,
      row.title,
      row.journal,
      row.year || "",
      row.doi || "",
      row.type || "",
      (row.editionLabels || row.editions).join("|"),
      row.impactFactor ?? "",
      row.bestQuartile || "",
      row.bestQuartileArea || "",
      row.allQuartiles.join("|"),
      row.issn || ""
    ];
    lines.push(values.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function topCounts(values, limit) {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function splitEditions(value) {
  return uniq(
    String(value || "")
      .split(/[;,/|]+/)
      .map((item) => compactSpaces(item).toUpperCase())
      .filter(Boolean)
  );
}

function extractIssn(value) {
  const matches = String(value || "").toUpperCase().match(/[0-9]{4}-[0-9]{3}[0-9X]/g) || [];
  return matches[0] || "";
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

function chooseBestQuartile(values) {
  const order = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
  const valid = values
    .map((value) => String(value || "").toUpperCase())
    .filter((value) => order[value]);
  if (!valid.length) return "";
  return valid.sort((a, b) => order[a] - order[b])[0];
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

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

if (require.main === module) {
  loadCatalogFromDisk();
  app.listen(PORT, () => {
    console.log(`Servidor activo en http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  parseTableFile,
  detectHeaderIndex,
  toObjectsFromHeader,
  mapCatalogRow,
  buildCatalog,
  normalizeOrcid,
  buildResearchReport
};
