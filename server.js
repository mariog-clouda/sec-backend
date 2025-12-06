const express = require("express");
const fetch = require("node-fetch");
const HTMLtoDOCX = require("html-docx-js");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudflare Worker: currently used only for XLSX HTML extraction
const WORKER_BASE_URL = "https://sec-fillings.mariog.workers.dev/";

// PDFShift (Headless Chrome HTML→PDF)
const PDFSHIFT_ENDPOINT = process.env.PDFSHIFT_ENDPOINT; // https://api.pdfshift.io/v3/convert/pdf
const PDFSHIFT_KEY = process.env.PDFSHIFT_KEY;           // your PDFShift API key

// ----------------- helpers -----------------

// Generic fetch helper that supports headers (needed for sec.gov)
async function fetchText(url, options = {}) {
  const r = await fetch(url, options);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Fetch failed ${r.status}: ${t}`);
  }
  return r.text();
}

function cleanCik(cik) {
  return String(cik).replace(/^0+/, "");
}

function cleanAccession(accession) {
  return String(accession).replace(/-/g, "");
}

// ---- 1) Ownership forms (3 / 4 / 5) static map ----
const OWNERSHIP_FORM_MAP = {
  "3": "xslF345X02/ownership.xml",
  "3/A": "xslF345X02/ownership.xml",
  "4": "xslF345X05/ownership.xml",
  "4/A": "xslF345X05/ownership.xml",
  "5": "xslF345X03/ownership.xml",
  "5/A": "xslF345X03/ownership.xml"
};

function getOwnershipStyledUrl(cik, accession, form) {
  const rel = OWNERSHIP_FORM_MAP[form.toUpperCase()];
  if (!rel) return null;
  const cikClean = cleanCik(cik);
  const accClean = cleanAccession(accession);
  return `https://www.sec.gov/Archives/edgar/data/${cikClean}/${accClean}/${rel}`;
}

// ---- 2) Generic index-based picker for all other forms ----
async function getPrimaryDocumentUrlFromIndex(cik, accession, form) {
  const cikClean = cleanCik(cik);
  const accClean = cleanAccession(accession);
  const normalizedForm = form.toUpperCase().trim();

  const baseFolder = `https://www.sec.gov/Archives/edgar/data/${cikClean}/${accClean}/`;

  // SEC requires a proper User-Agent
  const secHeaders = {
    "User-Agent": "CloudastructureSECWidget/1.0 (https://www.cloudastructure.com/contact)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };

  const indexCandidates = [
    `${baseFolder}${accClean}-index-headers.html`,
    `${baseFolder}${accClean}-index.html`
  ];

  let indexHtml = null;

  for (const url of indexCandidates) {
    try {
      indexHtml = await fetchText(url, { headers: secHeaders });
      break;
    } catch (_e) {
      // try next candidate
    }
  }

  if (!indexHtml) {
    throw new Error("Could not fetch any SEC index page for this accession");
  }

  const $ = cheerio.load(indexHtml);

  // SEC index usually has .tableFile; fallback to first table if not
  let table = $("table.tableFile").first();
  if (!table.length) {
    table = $("table").first();
  }
  if (!table.length) {
    throw new Error("No table found in SEC index page");
  }

  const rows = [];
  table.find("tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 2) return;

    const document = $(tds[0]).text().trim();
    const type = $(tds[1]).text().trim().toUpperCase();
    const description = tds[2] ? $(tds[2]).text().trim() : "";
    const sizeText = tds[3] ? $(tds[3]).text().trim() : "";

    if (!document) return;

    let size = 0;
    if (sizeText) {
      const num = parseFloat(sizeText.replace(/[^0-9.]/g, ""));
      if (!isNaN(num)) size = num;
    }

    rows.push({
      document,
      type,
      description,
      size
    });
  });

  if (!rows.length) {
    throw new Error("No document rows found in SEC index table");
  }

  const isHtmlDoc = (fname) =>
    fname.toLowerCase().endsWith(".htm") ||
    fname.toLowerCase().endsWith(".html");

  // Exact Type matches
  let matching = rows.filter(r => r.type === normalizedForm);

  let htmlMatches = matching.filter(r => isHtmlDoc(r.document));

  let chosen = null;

  if (htmlMatches.length) {
    let descMatches = htmlMatches.filter(r =>
      r.description.toUpperCase().includes(normalizedForm)
    );
    if (!descMatches.length) descMatches = htmlMatches;
    descMatches.sort((a, b) => (b.size || 0) - (a.size || 0));
    chosen = descMatches[0];
  } else if (matching.length) {
    chosen = matching[0];
  }

  if (!chosen) {
    const allHtml = rows.filter(r => isHtmlDoc(r.document));
    if (!allHtml.length) {
      chosen = rows[0];
    } else {
      allHtml.sort((a, b) => (b.size || 0) - (a.size || 0));
      chosen = allHtml[0];
    }
  }

  if (!chosen || !chosen.document) {
    throw new Error("Could not determine primary document from SEC index");
  }

  return baseFolder + chosen.document;
}

// For v1 we still handle XLSX via the Worker HTML (unchanged)
async function getFilingHtml(_cik, accession, _form) {
  const url = `${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`;
  return fetchText(url);
}

// ----------------- routes -----------------

// Health
app.get("/", (_req, res) => {
  res.send("SEC Backend running");
});

// PDF via PDFShift (styled, Chrome-rendered)
app.get("/filing-pdf", async (req, res) => {
  const { cik, accession, form, debug } = req.query;
  if (!cik || !accession || !form) {
    return res.status(400).send("Missing required query params");
  }

  const pdfEndpoint = process.env.PDFSHIFT_ENDPOINT;
  const pdfKey = process.env.PDFSHIFT_KEY;
  if (!pdfEndpoint || !pdfKey) {
    return res.status(500).send("PDF API not configured");
  }

  try {
    const normalizedForm = form.toUpperCase().trim();

    let filingUrl = null;

    // 1) Ownership forms: 3 / 4 / 5
    filingUrl = getOwnershipStyledUrl(cik, accession, normalizedForm);

    // 2) Everything else: index-based detection
    if (!filingUrl) {
      filingUrl = await getPrimaryDocumentUrlFromIndex(cik, accession, normalizedForm);
    }

    const auth = "Basic " + Buffer.from(`api:${pdfKey}`).toString("base64");

    let r = await fetch(pdfEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": auth
      },
      body: JSON.stringify({
        source: filingUrl,
        use_print_css: true
      })
    });

    if (r.status === 400) {
      const txt = await r.text();
      if (debug === "1") return res.status(400).send(txt);
      r = await fetch(pdfEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": auth
        },
        body: JSON.stringify({
          source: filingUrl,
          use_print: true
        })
      });
    }

    if (debug === "1") {
      const dbg = await r.text();
      return res.status(r.status).send(dbg);
    }

    if (!r.ok) {
      const errTxt = await r.text().catch(() => "");
      console.error("PDFShift error:", r.status, errTxt);
      return res.status(502).send("Error from PDF service");
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="filing-${cik}-${normalizedForm}.pdf"`
    );
    res.send(buf);
  } catch (e) {
    console.error("PDF generation error:", e);
    res.status(500).send("Error generating PDF");
  }
});


// XLSX (first table found – unchanged)
function extractFirstTable(html) {
  const $ = cheerio.load(html);
  const table = $("table").first();
  if (!table.length) return null;
  const rows = [];
  table.find("tr").each((_, tr) => {
    const cells = [];
    $(tr).find("th, td").each((__, cell) => cells.push($(cell).text().trim()));
    if (cells.length) rows.push(cells);
  });
  return rows.length ? rows : null;
}

app.get("/filing-xlsx", async (req, res) => {
  const { cik, accession, form } = req.query;
  if (!cik || !accession || !form) {
    return res.status(400).send("Missing required query params");
  }

  try {
    const html = await getFilingHtml(cik, accession, form);
    const table = extractFirstTable(html);
    if (!table) return res.status(400).send("No table found in filing");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    table.forEach(row => ws.addRow(row));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="filing-${cik}-${form}.xlsx"`
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error("XLSX generation error:", e);
    res.status(500).send("Error generating XLSX");
  }
});

// Quick env diagnostic
app.get("/__diag", (_req, res) => {
  res.json({
    workerBaseUrl: WORKER_BASE_URL,
    pdfshiftEndpoint: PDFSHIFT_ENDPOINT || null,
    hasPdfshiftKey: !!PDFSHIFT_KEY
  });
});

app.listen(PORT, () => console.log("Server running on port", PORT));









