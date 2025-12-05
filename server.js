const express = require("express");
const fetch = require("node-fetch");
const PDFDocument = require("pdfkit");
const HTMLtoDOCX = require("html-docx-js");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔴 IMPORTANT: replace this later with your real Cloudflare Worker URL
const WORKER_BASE_URL = "https://sec-fillings.mariog.workers.dev/";


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

  if (!cik || !accession || !form) {
    return res.status(400).send("Missing required query params");
  }

  try {
    const html = await getFilingHtml(cik, accession, form);

    // Extract plain text from HTML
    const $ = cheerio.load(html);
    const text = $("body").text().replace(/\s+\n/g, "\n").trim();

    // Create a PDF in memory
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(chunks);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="filing-${cik}-${form}.pdf"`
      );
      res.send(pdfBuffer);
    });

    doc.fontSize(14).text(`Filing ${form} – CIK ${cik}`, { underline: true });
    doc.moveDown();
    doc.fontSize(10).text(text, {
      width: 500
    });

    doc.end();
  } catch (e) {
    console.error(e);
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





