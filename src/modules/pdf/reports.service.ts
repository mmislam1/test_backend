// modules/reports/reports.service.ts
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';

const fetchImageBuffer = (url: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });

export const generateSearchPdf = async (searchData: any, results: any[]): Promise<{ filePath: string; fileName: string }> => {
  const pdfFolder = path.join(process.cwd(), 'pdf');
  if (!fs.existsSync(pdfFolder)) fs.mkdirSync(pdfFolder, { recursive: true });

  const fileName = `report_${searchData._id}_${Date.now()}.pdf`;
  const filePath = path.join(pdfFolder, fileName);

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const writeStream = fs.createWriteStream(filePath);
      doc.pipe(writeStream);

      // ── Header ──────────────────────────────────────────────────────────
      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .text('Image Intelligence Report', { align: 'center' });
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#888888')
        .text(`Report Generated on ${new Date().toLocaleDateString()}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#333333').lineWidth(1).stroke();
      doc.moveDown(1);

      // ── Query Details ───────────────────────────────────────────────────
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#222222').text('Query Details');
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica').fillColor('#444444');
      doc.text(`Search ID: ${searchData._id}`);
      doc.text(`Status:    ${searchData.status}`);
      doc.text(`Date:      ${new Date(searchData.date).toLocaleDateString()}`);
      doc.moveDown(1);

      // ── Visual Matches ──────────────────────────────────────────────────
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#222222')
        .text(`Visual Matches Found (${results.length})`);
      doc.moveDown(0.6);

      if (results.length === 0) {
        doc.fontSize(10).font('Helvetica').fillColor('#666666')
          .text('No visual matches were found for this search.');
      }

      for (let i = 0; i < results.length; i++) {
        const res = results[i];

        // Separator
        if (i > 0) {
          doc.moveDown(0.5);
          doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eeeeee').lineWidth(0.5).stroke();
          doc.moveDown(0.5);
        }

        const startY = doc.y;
        const imgX = 50;
        const imgSize = 90;
        const textX = imgX + imgSize + 14;
        const textWidth = 545 - textX;

        // Try to embed the match image
        try {
          const imgBuf = await fetchImageBuffer(res.image);
          doc.image(imgBuf, imgX, startY, { width: imgSize, height: imgSize, fit: [imgSize, imgSize] });
        } catch {
          doc.rect(imgX, startY, imgSize, imgSize).strokeColor('#dddddd').stroke();
          doc.fontSize(8).fillColor('#aaaaaa').text('Image unavailable', imgX, startY + imgSize / 2 - 5, { width: imgSize, align: 'center' });
        }

        // Text beside image
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#222222')
          .text(`Match #${i + 1}`, textX, startY, { width: textWidth });
        doc.font('Helvetica').fontSize(9).fillColor('#444444');
        doc.text(`Source: ${res.details?.source || 'N/A'}`, textX, doc.y, { width: textWidth });
        doc.text(`Title:  ${res.details?.title || 'No Title'}`, textX, doc.y, { width: textWidth });
        if (res.details?.link) {
          doc.fillColor('#0066cc').text(`Link: ${res.details.link}`, textX, doc.y, { width: textWidth });
          doc.fillColor('#444444');
        }

        // Advance past image if text was shorter
        if (doc.y < startY + imgSize + 8) {
          doc.y = startY + imgSize + 8;
        }

        // Page break if needed
        if (doc.y > 720) doc.addPage();
      }

      // ── Footer ───────────────────────────────────────────────────────────
      doc.moveDown(2);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eeeeee').lineWidth(0.5).stroke();
      doc.moveDown(0.4);
      doc.fontSize(8).fillColor('#aaaaaa')
        .text('This is an automated report. Confidentiality applies.', { align: 'center' });

      doc.end();

      writeStream.on('finish', () => resolve({ filePath, fileName }));
      writeStream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
};