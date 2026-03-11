const catalogForm = document.getElementById("catalog-form");
const catalogFileInput = document.getElementById("catalog-file");
const catalogStatus = document.getElementById("catalog-status");

const researcherForm = document.getElementById("researcher-form");
const orcidInput = document.getElementById("orcid-input");
const researcherSubmit = document.getElementById("researcher-submit");
const message = document.getElementById("message");

const summarySection = document.getElementById("summary-section");
const summaryGrid = document.getElementById("summary-grid");
const tableSection = document.getElementById("table-section");
const resultsBody = document.getElementById("results-body");
const downloadCsvButton = document.getElementById("download-csv");
const downloadJsonButton = document.getElementById("download-json");

let lastReport = null;

catalogForm.addEventListener("submit", onCatalogUpload);
researcherForm.addEventListener("submit", onGenerateReport);
downloadCsvButton.addEventListener("click", onDownloadCsv);
downloadJsonButton.addEventListener("click", onDownloadJson);

refreshCatalogStatus();

async function refreshCatalogStatus() {
  try {
    const response = await fetch("/api/catalog/status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo leer estado del catalogo.");

    if (data.loaded) {
      const uploadedAt = data.meta?.uploadedAt ? new Date(data.meta.uploadedAt).toLocaleString() : "-";
      catalogStatus.textContent = `Catalogo cargado: SI | Revistas: ${data.journalCount} | Archivo: ${
        data.meta?.sourceFileName || "-"
      } | Fecha: ${uploadedAt}`;
      researcherSubmit.disabled = false;
    } else {
      catalogStatus.textContent = "Catalogo cargado: NO. Debes cargar el archivo JCR/WoS una vez.";
      researcherSubmit.disabled = true;
    }
  } catch (error) {
    catalogStatus.textContent = error.message || "Error al leer estado del catalogo.";
    researcherSubmit.disabled = true;
  }
}

async function onCatalogUpload(event) {
  event.preventDefault();
  const file = catalogFileInput.files?.[0];
  if (!file) {
    setMessage("Selecciona un archivo de catalogo.", true);
    return;
  }

  setMessage("Cargando catalogo...", false);
  disableDuring(catalogForm, true);
  try {
    const body = new FormData();
    body.append("catalogFile", file);
    const response = await fetch("/api/catalog/upload", {
      method: "POST",
      body
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo cargar catalogo.");

    setMessage(`Catalogo cargado correctamente. Revistas: ${data.journalCount}.`, false);
    await refreshCatalogStatus();
  } catch (error) {
    setMessage(error.message || "Error al cargar catalogo.", true);
  } finally {
    disableDuring(catalogForm, false);
  }
}

async function onGenerateReport(event) {
  event.preventDefault();
  const rawOrcid = orcidInput.value.trim();
  if (!rawOrcid) return;

  setMessage("Consultando ORCID y validando con JCR...", false);
  clearReport();
  disableDuring(researcherForm, true);
  try {
    const response = await fetch(`/api/researcher/report?orcid=${encodeURIComponent(rawOrcid)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo generar reporte.");

    lastReport = data;
    renderSummary(data);
    renderTable(data.publications || []);
    setMessage("", false);
  } catch (error) {
    setMessage(error.message || "Error al generar reporte.", true);
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
    ["Tasa validacion", `${stats.validationRate ?? 0}%`],
    ["IF promedio", stats.averageImpactFactor ?? "-"],
    ["IF maximo", stats.maxImpactFactor ?? "-"],
    [
      "Distribucion cuartiles",
      `Q1:${stats.quartileDistribution?.Q1 ?? 0} Q2:${stats.quartileDistribution?.Q2 ?? 0} Q3:${
        stats.quartileDistribution?.Q3 ?? 0
      } Q4:${stats.quartileDistribution?.Q4 ?? 0}`
    ],
    [
      "Top areas",
      (stats.topBestQuartileAreas || [])
        .map((item) => `${item.value} (${item.count})`)
        .join(" | ") || "-"
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
    td.colSpan = 10;
    td.textContent = "No se encontraron publicaciones validadas en SCIE/SSCI.";
    tr.appendChild(td);
    resultsBody.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();
  publications.forEach((item) => {
    const tr = document.createElement("tr");
    tr.appendChild(cell(item.title));
    tr.appendChild(cell(item.journal));
    tr.appendChild(cell(item.year || "-"));
    tr.appendChild(cell((item.editions || []).join(", ")));
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

function onDownloadCsv() {
  if (!lastReport) return;
  const orcid = lastReport.researcher?.orcid;
  if (!orcid) return;
  window.location.href = `/api/researcher/report.csv?orcid=${encodeURIComponent(orcid)}`;
}

function onDownloadJson() {
  if (!lastReport) return;
  const text = JSON.stringify(lastReport, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const orcid = lastReport.researcher?.orcid?.replace(/-/g, "") || "investigador";
  a.download = `reporte_orcid_${orcid}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clearReport() {
  lastReport = null;
  summarySection.classList.add("hidden");
  tableSection.classList.add("hidden");
  summaryGrid.innerHTML = "";
  resultsBody.innerHTML = "";
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
