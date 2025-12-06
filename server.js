// --- imports / setup ---
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");
// (DOCX not used yet, leaving out to keep it minimal)

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudflare Worker (fallback listing)
const WORKER_BASE_URL = "https://sec-fillings.mariog.workers.dev/";

// PDFShift (Headless Chrome HTML→PDF)
const PDFSHIFT_ENDPOINT = process.env.PDFSHIFT_ENDPOINT; // e.g. https://api.pdfshift.io/v3/convert/pdf
const PDFSHIFT_KEY = process.env.PDFSHIFT_KEY;           // format: plain key (we apply Basic api:{KEY})

// --- constants / helpers ---
const SEC_HEADERS = {
  "User-Agent": "CloudastructureSECWidget/1.0 (https://www.cloudastructure.com/contact)",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

function cleanCik(cik) {
  return String(cik).replace(/^0+/, "");
}
function cleanAccession(accession) {
  return String(accession).replace(/-/g, "");
}
function secArchiveBase(cik, accession) {
  const cikClean = cleanCik(cik);
  const accClean = cleanAccession(accession);
  return `https://www.sec.gov/Archives/edgar/data/${cikClean}/${accClean}/`;
}
function isHtmlName(name) {
  return /\.html?$/i.test(name || "");
}

// Generic fetch that returns text (with optional headers)
async function fetchText(url, options = {}) {
  const r = await fetch(url, options);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Fetch failed ${r.status}: ${t}`);
  }
  return r.text();
}

// --- Your explicit form → filename patterns (from your mapping) ---
const FORM_FILENAME_PATTERNS = {
  "1-A":          [/xsl1-A_X01\/primary_doc\.xml/i],
  "1-A POS":      [/xsl1-A_X01\/primary_doc\.xml/i],
  "1-A/A":        [/xsl1-A_X01\/primary_doc\.xml/i],
  "1-K":          [/xsl1-K_X01\/primary_doc\.xml/i],

  "1-SA":         [/cloud_1sa\.htm/i, /cloudastructure_1sa\.htm/i],
  "1-U":          [/cloudastructure_1u\.htm/i, /cloud_1u\.htm/i],

  "10-K":         [/cloudastructure_i10k/i, /10k/i],
  "10-Q":         [/cloudastructure_i10q/i, /10q/i],

  "144":          [/xsl144X01\/primary_doc\.xml/i],

  "253G2":        [/cloudastructure_253g2\.htm/i, /cloud_253g2\.htm/i],

  "3":            [/xslF345X02\/ownership\.xml/i],
  "4":            [/xslF345X05\/ownership\.xml/i],

  "424B3":        [/cloudastructure_424b3\.htm/i, /424b3/i],
  "424B4":        [/cloudastructure_424b4\.htm/i, /424b4/i],

  "8-A12B":       [/cloud_8a12b\.htm/i],
  "8-K":          [/cloudastructure_8k\.htm/i],
  "8-K/A":        [/cloudastructure_8ka\.htm/i],

  "C":            [/xslC_X01\/primary_doc\.xml/i],
  "C-AR":         [/xslC_X01\/primary_doc\.xml/i],
  "C-TR":         [/xslC_X01\/primary_doc\.xml/i],
  "C-U":          [/xslC_X01\/primary_doc\.xml/i],
  "C/A":          [/xslC_X01\/primary_doc\.xml/i],

  "CERT":         [/\.pdf$/i],                  // SEC native PDF
  "SEC STAFF ACTION": [/\.pdf$/i],
  "UPLOAD":       [/\.pdf$/i],

  "CORRESP":      [/filename1\.htm/i],
  "DRS":          [/filename1\.htm/i],
  "DRS/A":        [/filename1\.htm/i],
  "DRSLTR":       [/filename1\.htm/i],

  "EFFECT":       [/xslEFFECTX01\/primary_doc\.xml/i],
  "PRE 14A":      [/cloud_pre14a\.htm/i],

  "QUALIF":       [/xslQUALIFX01\/primary_doc\.xml/i],

  "S-1":          [/cloudastructure_ex/i],      // from your list
  "S-1/A":        [/cloudastructure_s1/i, /s-1a|s1a/i],
  "S-8":          [/cloudastructure_s8/i, /s-8/i],
  "DEF 14A":      [/cloud_def14a\.htm/i],
  "DEFA14A":      [/cloud_defa14a\.htm/i],
  "DEFR14A":      [/cloud_defr14a\.htm/i]
};

// Ownership forms direct map (deterministic XSL paths)
const OWNERSHIP_FORM_MAP = {
  "3": "xslF345X02/ownership.xml",
  "3/A": "xslF345X02/ownership.xml",
  "4": "xslF345X05/ownership.xml",
  "4/A": "xslF345X05/ownership.xml",
  "5": "xslF345X03/ownership.xml",
  "5/A": "xslF345X03/ownership.xml"
};

// Some other forms also have deterministic XSL paths
function directXslIfKnown(formUpper) {
  if (formUpper === "144")     return "xsl144X01/primary_doc.xml";
  if (formUpper === "EFFECT")  return "xslEFFECTX01/primary_doc.xml";
  if (formUpper === "1-K" || formUpper === "1K") return "xsl1-K_X01/primary_doc.xml";
  if (formUpper === "1-A" || formUpper === "1-A POS" || formUpper === "1-A/A" || formUpper === "1A") {
    return "xsl1-A_X01/primary_doc.xml";
  }
  if (["C", "C-AR", "C-TR", "C-U", "C/A"].includes(formUpper)) {
    return "xslC_X01/primary_doc.xml";
  }
  if (formUpper === "D") return "xslFormDX01/primary_doc.xml";
  if (formUpper === "QUALIF") return "xslQUALIFX01/primary_doc.xml";
  return null;
}

// --- Parse the SEC index HTML to pick a primary document filename ---
async function getPrimaryFromSecIndex(cik, accession, formUpper) {
  const base = secArchiveBase(cik, accession);
  const accClean = cleanAccession(accession);
  const indexCandidates = [
    `${base}${accClean}-index-headers.html`,
    `${base}${accClean}-index.html`
  ];

  let indexHtml = null;
  for (const url of indexCandidates) {
    try {
      indexHtml = await fetchText(url, { headers: SEC_HEADERS });
      break;
    } catch (_) { /* try next */ }
  }
  if (!indexHtml) throw new Error("Could not fetch SEC index page");

  const $ = cheerio.load(indexHtml);
  let table = $("table.tableFile").first();
  if (!table.length) table = $("table").first();
  if (!table.length) throw new Error("No table found in SEC index");

  const rows = [];
  table.find("tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 2) return;
    const document = $(tds[0]).text().trim();          // e.g. cloudastructure_i10q.htm
    const type = $(tds[1]).text().trim().toUpperCase(); // e.g. 10-Q
    const description = tds[2] ? $(tds[2]).text().trim() : "";
    const sizeText = tds[3] ? $(tds[3]).text().trim() : "";
    let size = 0;
    if (sizeText) {
      const num = parseFloat(sizeText.replace(/[^0-9.]/g, ""));
      if (!isNaN(num)) size = num;
    }
    if (document) rows.push({ document, type, description, size });
  });

  if (!rows.length) throw new Error("No document rows found in SEC index");

  // 1) Try explicit patterns you mapped
  const pats = FORM_FILENAME_PATTERNS[formUpper];
  if (pats && pats.length) {
    for (const rx of pats) {
      const hit = rows.find(r => rx.test(r.document));
      if (hit) return base + hit.document;
    }
  }

  // 2) Exact type match → prefer HTML → prefer larger
  const isHtmlDoc = (f) => isHtmlName(f.document);
  let sameType = rows.filter(r => r.type === formUpper);
  if (sameType.length) {
    let htmlSameType = sameType.filter(isHtmlDoc);
    if (htmlSameType.length) {
      htmlSameType.sort((a, b) => (b.size || 0) - (a.size || 0));
      return base + htmlSameType[0].document;
    }
    // if none HTML, just take the first
    return base + sameType[0].document;
  }

  // 3) Any HTML → prefer largest
  const anyHtml = rows.filter(isHtmlDoc);
  if (anyHtml.length) {
    anyHtml.sort((a, b) => (b.size || 0) - (a.size || 0));
    return base + anyHtml[0].document;
  }

  // 4) Fallback: first row
  return base + rows[0].document;
}

// --- Worker fallback: ask /filing for files[] then pick with patterns ---
async function getPrimaryFromWorker(cik, accession, formUpper) {
  const r = await fetch(`${WORKER_BASE_URL}filing?accession=${encodeURIComponent(accession)}`);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Worker listing failed ${r.status}: ${t}`);
  }
  const files = await r.json();
  if (!Array.isArray(files) || !files.length) throw new Error("No files from worker");

  const pats = FORM_FILENAME_PATTERNS[formUpper];
  if (pats && pats.length) {
    for (const rx of pats) {
      const hit = files.find(f => rx.test(f.filename || ""));
      if (hit && hit.url) return hit.url;
    }
  }

  const htmls = files.filter(f => f && (f.type === "html" || isHtmlName(f.filename)));
  if (htmls.length) {
    // prefer non-index/header
    const main = htmls.find(f => !/index|header|headers|idx/i.test((f.filename || ""))) || htmls[0];
    return main.url;
  }

  // no html? use native PDF if present
  const pdf = files.find(f => f && f.type === "pdf");
  if (pdf && pdf.url) return pdf.url;

  // last resort
  return files[0].url;
}

// --- Unified resolver: returns a URL to the primary doc (HTML/XML/PDF) ---
async function resolvePrimaryUrl(cik, accession, formRaw) {
  const formUpper = (formRaw || "").trim().toUpperCase();
  const base = secArchiveBase(cik, accession);

  // Ownership forms are deterministic
  if (OWNERSHIP_FORM_MAP[formUpper]) {
    return base + OWNERSHIP_FORM_MAP[formUpper];
  }

  // Some other forms also have deterministic XSL paths
  const direct = directXslIfKnown(formUpper);
  if (direct) return base + direct;

  // Try SEC index
  try {
    return await getPrimaryFromSecIndex(cik, accession, formUpper);
  } catch (e) {
    console.warn("Index resolver failed, trying worker:", e.message);
  }

  // Fallback to worker
  return await getPrimaryFromWorker(cik, accession, formUpper);
}

// --- ROUTES ---

// Health
app.get("/", (_req, res) => {
  res.send("SEC Backend running");
});

// Create PDF from a filing (ALL forms supported)
app.get("/filing-pdf", async (req, res) => {
  const { cik, accession, form, debug } = req.query;
  if (!cik || !accession || !form) {
    return res.status(400).send("Missing required query params");
  }

  if (!PDFSHIFT_ENDPOINT || !PDFSHIFT_KEY) {
    return res.status(500).send("PDF API








