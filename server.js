const express = require("express");
const fetch = require("node-fetch");
const HTMLtoDOCX = require("html-docx-js");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudflare Worker: serves formatted Form 4 at /form4?accession=...
const WORKER_BASE_URL = "https://sec-fillings.mariog.workers.dev/";

// PDFShift (Headless Chrome HTML→PDF)
const PDFSHIFT_ENDPOINT = process.env.PDFSHIFT_ENDPOINT; // https://api.pdfshift.io/v3/convert/pdf
const PDFSHIFT_KEY = process.env.PDFSHIFT_KEY;           // your PDFShift API key

// ----------------- helpers -----------------
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Fetch failed ${r.status}: ${t}`);
  }
  return r.text();
}

// For v1 we handle Form 4 via /form4 (extend later for other forms)
async function getFilingHtml(_cik, accession, form) {
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
  if (!cik || !accession || !form) return res.status(400).send("Missing required query params");

  const PDFSHIFT_ENDPOINT = process.env.PDFSHIFT_ENDPOINT;
  const PDFSHIFT_KEY = process.env.PDFSHIFT_KEY;
  if (!PDFSHIFT_ENDPOINT || !PDFSHIFT_KEY) return res.status(500).send("PDF API not configured");

  try {
    const filingUrl = `${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`;

    // PDFShift requires Basic auth: "api:{KEY}"
    const auth = "Basic " + Buffer.from(`api:${PDFSHIFT_KEY}`).toString("base64");

    // Minimal payload: just the URL and print CSS. No margins/background fields.
    let r = await fetch(PDFSHIFT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": auth },
      body: JSON.stringify({
        source: filingUrl,
        use_print_css: true
      })
    });

    // If provider doesn’t accept use_print_css, fallback to use_print
    if (r.status === 400) {
      const txt = await r.text();
      if (debug === "1") return res.status(400).send(txt);
      r = await fetch(PDFSHIFT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": auth },
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
    res.setHeader("Content-Disposition", `attachment; filename="filing-${cik}-${form}.pdf"`);
    res.send(buf);
  } catch (e) {
    console.error("PDF generation error:", e);
    res.status(500).send("Error generating PDF");
  }
});



// XLSX (first table found)
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
  if (!cik || !accession || !form) return res.status(400).send("Missing required query params");

  try {
    const html = await getFilingHtml(cik, accession, form);
    const table = extractFirstTable(html);
    if (!table) return res.status(400).send("No table found in filing");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    table.forEach(row => ws.addRow(row));

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="filing-${cik}-${form}.xlsx"`);
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














