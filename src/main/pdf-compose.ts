/**
 * Stamp a "bells used" header strip onto the top of a rendered player PDF.
 *
 * MuseScore's CLI won't render manually-authored frame images, so rather than
 * inject the strip into the score we render it separately (src/core/bells-used
 * → src/main/mscore renderTrimmedPng) and composite it here: page 1 is grown by
 * a header band, the original page redrawn below it, and the caption + colored
 * staff image placed in the band. Later pages are untouched.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function addBellsUsedBand(
  pdfBytes: Uint8Array,
  stripPngBytes: Uint8Array,
  bellCount: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const png = await doc.embedPng(stripPngBytes);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await doc.embedFont(StandardFonts.TimesRomanBold);

  const page1 = doc.getPage(0);
  const { width: W, height: H } = page1.getSize();

  // Aim for a consistent, legible notehead size (fixed band height) and let the
  // strip grow up to most of the page width; only very wide strips (many bells)
  // shrink to fit.
  const maxW = W * 0.9;
  let bandH = 46;
  let bandW = bandH * (png.width / png.height);
  if (bandW > maxW) {
    bandW = maxW;
    bandH = bandW * (png.height / png.width);
  }

  const tSize = 13, cSize = 10;
  const padTop = 14, gap1 = 4, gap2 = 9, padBot = 14;
  const band = padTop + tSize + gap1 + cSize + gap2 + bandH + padBot;

  // Redraw the original page 1 at the bottom of a taller page, header on top.
  const embedded = await doc.embedPage(page1);
  const np = doc.insertPage(0, [W, H + band]);
  np.drawPage(embedded, { x: 0, y: 0, width: W, height: H });

  const topY = H + band;
  const title = 'Bells Used';
  const count = `${bellCount} bell${bellCount === 1 ? '' : 's'}`;
  const titleW = fontBold.widthOfTextAtSize(title, tSize);
  const countW = font.widthOfTextAtSize(count, cSize);

  const titleBase = topY - padTop - tSize;
  np.drawText(title, {
    x: (W - titleW) / 2, y: titleBase, size: tSize, font: fontBold, color: rgb(0.12, 0.12, 0.12),
  });
  const countBase = titleBase - gap1 - cSize;
  np.drawText(count, {
    x: (W - countW) / 2, y: countBase, size: cSize, font, color: rgb(0.38, 0.38, 0.38),
  });
  const imgTop = countBase - gap2;
  np.drawImage(png, { x: (W - bandW) / 2, y: imgTop - bandH, width: bandW, height: bandH });

  // Drop the untouched original page 1 (now at index 1); its clone lives at 0.
  doc.removePage(1);
  return doc.save();
}
