const express = require("express");
const fetch = require("node-fetch");
const HTMLtoDOCX = require("html-docx-js");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔴 IMPORTANT: replace this later with your real Cloudflare Worker URL
const WORKER_BASE_URL = "https://sec-fillings.mariog.workers.dev/";
const PDF_API_ENDPOINT = process.env.PDF_API_ENDPOINT;
const PDF_API_KEY = process.env.PDF_API_KEY;


/**
 * Fetch HTML from your Worker
 */
async function getFilingHtml(cik, accession, form) {
  let url;

  // For now we handle Form 4 explicitly via /form4
  if (String(form).trim() === "4") {
    url = `${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`;
  } else {
    // Fallback – you can extend this later for other forms
    url = `${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`;
  }

  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Worker error (${res.status}): ${res.statusText} ${text}`
    );
  }

  const html = await res.text();
  return html;
}


/**
 * PDF route
 */

app.get("/filing-pdf", async (req, res) => {
  const { cik, accession, form } = req.query;
  if (!cik || !accession || !form) return res.status(400).send("Missing required query params");
  if (!PDF_API_ENDPOINT || !PDF_API_KEY) return res.status(500).send("PDF API not configured");

  try {
    const filingUrl = `${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`; // Form 4 for now
    const url = `${PDF_API_ENDPOINT}?access_key=${encodeURIComponent(PDF_API_KEY)}&document_url=${encodeURIComponent(filingUrl)}`;

    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("pdflayer error:", r.status, text);
      return res.status(500).send("Error from PDF API");
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



/**
 * DOCX route
 */
app.get("/filing-docx", async (req, res) => {
  const { cik, accession, form } = req.query;

  try {
    const html = await getFilingHtml(cik, accession, form);

    // html-docx-js: use asBuffer() to generate a DOCX buffer
    const buffer = HTMLtoDOCX.asBuffer(html);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="filing-${cik}-${form}.docx"`
    );

    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).send("Error generating DOCX");
  }

});

/**
 * Extract first table from HTML
 */
function extractFirstTable(html) {
  const $ = cheerio.load(html);
  const table = $("table").first();
  if (!table.length) return null;

  const rows = [];
  table.find("tr").each((_, tr) => {
    const cells = [];
    $(tr)
      .find("th, td")
      .each((__, cell) => {
        cells.push($(cell).text().trim());
      });
    rows.push(cells);
  });

  return rows;
}

/**
 * XLSX route
 */
app.get("/filing-xlsx", async (req, res) => {
  const { cik, accession, form } = req.query;

  try {
    const html = await getFilingHtml(cik, accession, form);
    const table = extractFirstTable(html);

    if (!table) return res.status(400).send("No table found");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");

    table.forEach((row) => sheet.addRow(row));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="filing-${cik}-${form}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).send("Error generating XLSX");
  }
});

/**
 * Health check
 */
app.get("/", (req, res) => {
  res.send("SEC Backend running");
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});








