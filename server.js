const express = require("express");
const fetch = require("node-fetch");
const HTMLtoDOCX = require("html-docx-js");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;

// Your Cloudflare Worker (serves formatted Form 4 at /form4?accession=...)
const WORKER_BASE_URL = "https://sec-fillings.mariog.workers.dev/";

// Api2Pdf (Chrome HTML→PDF) – set these in Render → Environment
const API2PDF_ENDPOINT = process.env.API2PDF_ENDPOINT; // e.g. https://v2.api2pdf.com/chrome/url-to-pdf
const API2PDF_KEY = process.env.API2PDF_KEY;           // your Api2Pdf key

// ----------------- helpers -----------------
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Fetch failed ${r.status}: ${t}`);
  }
  return r.text();
}

// For now, handle Form 4 via /form4; extend later for 8-K/10-K/etc.
async function getFilingHtml(_cik, accession, form) {
  const isForm4 = String(form).trim() === "4";
  const url = `${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`;
  // We always call /form4 while you’re finishing v1; change this when adding more forms.
  return fetchText(url);
}

// ----------------- routes -----------------

// Health
app.get("/", (_req, res) => {
  res.send("SEC Backend running");
});

// PDF (styled) via Api2Pdf (Chrome renders XML+XSL like a browser)
app.get("/filing-pdf", async (req, res) => {
  const { cik, accession, form } = req.query;
  if (!cik || !accession || !form) return res.status(400).send("Missing required query params");

  if (!API2PDF_ENDPOINT || !API2PDF_KEY) {
    console.error("Missing API2PDF_ENDPOINT or API2PDF_KEY");
    return res.status(500).send("PDF API not configured");
  }

  try {
    // Give Api2Pdf the rendered filing URL (your Worker)
    const filingUrl = `${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`;

    const r = await fetch(API2PDF_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": API2PDF_KEY
      },
      body: JSON.stringify({
        url: filingUrl,
        inlinePdf: false,
        printBackground: true,
        // Optional: page settings
        // options: { paperWidth: 8.5, paperHeight: 11, marginTop: 0.5, marginBottom: 0.5, marginLeft: 0.5, marginRight: 0.5 }
      })
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error("Api2Pdf error:", r.status, txt);
      return res.status(500).send("Error from PDF API");
    }

    // Api2Pdf typically returns JSON: { success, pdf, ... }
    const data = await r.json().catch(() => null);

    if (data && data.pdf) {
      // data.pdf is a temporary URL to the generated PDF
      const pdfFetch = await fetch(data.pdf);
      if (!pdfFetch.ok) {
        const t = await pdfFetch.text().catch(() => "");
        console.error("Fetch PDF URL error:", pdfFetch.status, t);
        return res.status(500).send("Error fetching generated PDF");
      }
      const buf = Buffer.from(await pdfFetch.arrayBuffer());
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="filing-${cik}-${form}.pdf"`);
      return res.send(buf);
    }

    // Fallback in case the API returned binary directly (rare)
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="filing-${cik}-${form}.pdf"`);
    return res.send(buf);
  } catch (e) {
    console.error("PDF generation error:", e);
    res.status(500).send("Error generating PDF");
  }
});

// DOCX (turn Worker HTML into .docx)
app.get("/filing-docx", async (req, res) => {
  const { cik, accession, form } = req.query;
  if (!cik || !accession || !form) return res.status(400).send("Missing required query params");

  try {
    const html = await getFilingHtml(cik, accession, form);
    const buffer = HTMLtoDOCX.asBuffer(html);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="filing-${cik}-${form}.docx"`);
    res.send(buffer);
  } catch (e) {
    console.error("DOCX generation error:", e);
    res.status(500).send("Error generating DOCX");
  }
});

// XLSX (first table found in the HTML)
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

app.listen(PORT, () => console.log("Server running on port", PORT));









