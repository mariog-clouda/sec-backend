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

    // Helper: one attempt to PDFShift
    const callPdfShift = async (authHeader) => {
      const r = await fetch(PDFSHIFT_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authHeader
        },
        body: JSON.stringify({
          source: filingUrl,
          use_print: true,
          include_background: true,
          landscape: false,
          margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
        })
      });
      return r;
    };

    // Try with "key:" (most providers expect the colon)
    const authWithColon = "Basic " + Buffer.from(`${PDFSHIFT_KEY}:`).toString("base64");
    let resp = await callPdfShift(authWithColon);
    let raw = await resp.text();

    // If 401, try again WITHOUT the colon (some setups require this)
    if (resp.status === 401) {
      const authNoColon = "Basic " + Buffer.from(PDFSHIFT_KEY).toString("base64");
      resp = await callPdfShift(authNoColon);
      raw = await resp.text();
    }

    // Debug: show exactly what PDFShift returns
    if (debug === "1") {
      return res.status(resp.status).type("application/json; charset=utf-8").send(raw);
    }

    if (!resp.ok) {
      console.error("PDFShift error:", resp.status, raw?.slice?.(0, 400) || raw);
      return res.status(502).send("PDF service error.");
    }

    // Success: resp body is binary PDF
    const pdfBuffer = Buffer.from(raw, "binary"); // raw is already the PDF bytes
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="filing-${cik}-${form}.pdf"`);
    return res.send(pdfBuffer);
  } catch (e) {
    console.error("PDF generation error:", e);
    return res.status(500).send("Error generating PDF");
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












