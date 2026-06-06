import PDFDocument from 'pdfkit';

export class PdfService {
  async generateResultsPdf(matches: any[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData.toString('base64'));
      });
      doc.on('error', reject);

      // PDF Header
      doc.fontSize(20).text('Yandex Reverse Image Search Results', { align: 'center' });
      doc.moveDown(2);

      if (!matches || matches.length === 0) {
        doc.fontSize(14).text('No matches were found for this image.', { align: 'center' });
      } else {
        // List each match
        matches.forEach((match, index) => {
          doc.fontSize(14).fillColor('black').text(`${index + 1}. ${match.title || 'Untitled Result'}`);
          doc.fontSize(10).fillColor('gray').text(`Domain: ${match.domain || 'Unknown'}`);
          doc.fontSize(10).fillColor('blue').text(`URL: ${match.url}`, { link: match.url, underline: true });
          doc.moveDown(1);
        });
      }

      doc.end();
    });
  }
}

export const pdfService = new PdfService();