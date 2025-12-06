const express = require("express");
const fetch = require("node-fetch");
const HTMLtoDOCX = require("html-docx-js");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;

// Worker that returns formatted Form 4 when called as /form4?accession=...
const WORKER_BASE_URL = "https://sec-fillings.mariog.workers.dev/";

// PDF API (pdflayer)
const PDF_API_ENDPOINT = process.env.PDF_API_ENDPOINT; // e.g. https://api.pdflayer.com/api/convert
const PDF_API_KEY = process.env.PDF_API_KEY;           // your pdflayer access_key

// ---------- helpers ----------
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Fetch failed ${r.status}: ${t}`);
  }
  return r.text();
}

// For now we handle Form 4 via /form4 (you can add more later)
async function getFilingHtml(_cik, accession, form) {
  if (String(form).trim() === "4") {
    return fetchText(`${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`);
  }
  // default to form4 path for now so we always get something back during setup
  return fetchText(`${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`);
}

// ---------- routes ----------

// Root health
app.get("/", (_req, res) => {
  res.send("SEC Backend running");
});

// PDF via pdflayer (HTML→PDF)
app.get("/filing-pdf", async (req, res) => {
  const { cik, accession, form } = req.query;
  if (!cik || !accession || !form) return res.status(400).send("Missing required query params");

  const endpoint = process.env.API2PDF_ENDPOINT;
  const key = process.env.API2PDF_KEY;
  if (!endpoint || !key) return res.status(500).send("PDF API not configured");

  try {
    // Use your Worker’s formatted Form 4 URL (XML + XSL; Chrome will render it)
    const filingUrl = `${WORKER_BASE_URL}form4?accession=${encodeURIComponent(accession)}`;

    // Api2Pdf expects POST with JSON and Authorization header
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key
      },
      body: JSON.stringify({
        url: filingUrl,
        inlinePdf: false,          // return PDF data (not just URL)
        printBackground: true,
        landscape: false,
        // optional margins / paper size if you want:
        // options: { paperWidth: 8.5, paperHeight: 11, marginTop: 0.5, marginBottom: 0.5, marginLeft: 0.5, marginRight: 0.5 }
      })
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error("Api2Pdf error:", r.status, txt);
      return res.status(500).send("Error from PDF API");
    }

    // Api2Pdf returns JSON by default: { success, pdf, mbIn, mbOut, ... }
    const data = await r.json().catch(() => null);

    // If it returned binary directly (rare), handle that too:
    if (data && data.pdf) {
      // data.pdf is a URL to the generated PDF (temporary). Fetch and stream it.
      const pdfFetch = await fetch(data.pdf);
      const buf = Buffer.from(await pdfFetch.arrayBuffer());
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="filing-${cik}-${form}.pdf"`);
      return res.send(buf);
    } else {
      // Fallback if endpoint returned binary directly:
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="filing-${cik}-${form}.pdf"`);
      return res.send(buf);
    }
  } catch (e) {
    console.error("PDF generation error:", e);
    res.status(500).send("Error generating PDF");
  }
});


// DOCX (we'll fix after PDF; still wired to Worker HTML)
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

// XLSX (first table only)
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









