#!/usr/bin/env node
/* Rebuilds the PDF fixtures the tests sign.
 * NODE_PATH=/tmp/pdftest/node_modules node tests/make_fixtures.cjs
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const OUT = path.join(__dirname, 'fixtures');

const INK = rgb(0.05, 0.11, 0.14);
const RULE = rgb(0.85, 0.85, 0.84);

function rule(page, y, width, margin) {
  page.drawLine({
    start: { x: margin, y: y },
    end: { x: width - margin, y: y },
    thickness: 0.7,
    color: RULE
  });
}

async function contract() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = [595.28, 841.89];
  for (let index = 0; index < 3; index += 1) {
    const page = doc.addPage(size);
    page.drawText('Consulting agreement', { x: 60, y: 770, size: 16, font: bold, color: INK });
    page.drawText('Page ' + (index + 1) + ' of 3', { x: 60, y: 750, size: 10, font, color: INK });
    for (let line = 0; line < 20; line += 1) rule(page, 700 - line * 22, size[0], 60);
    if (index === 2) {
      page.drawText('Signature:', { x: 60, y: 190, size: 11, font, color: INK });
      page.drawLine({ start: { x: 130, y: 185 }, end: { x: 320, y: 185 }, thickness: 0.8, color: INK });
      page.drawText('Date:', { x: 60, y: 150, size: 11, font, color: INK });
      page.drawLine({ start: { x: 100, y: 145 }, end: { x: 230, y: 145 }, thickness: 0.8, color: INK });
    }
  }
  doc.setTitle('Sample contract');
  fs.writeFileSync(path.join(OUT, 'contract.pdf'), await doc.save());
}

async function form() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Permission slip', { x: 60, y: 760, size: 16, font: bold, color: INK });
  page.drawText('I allow my child to join the trip on 12 November.', {
    x: 60, y: 720, size: 11, font, color: INK
  });
  page.drawText('Parent signature:', { x: 60, y: 210, size: 11, font, color: INK });
  page.drawLine({ start: { x: 160, y: 205 }, end: { x: 420, y: 205 }, thickness: 0.9, color: INK });
  page.drawText("Date:", { x: 60, y: 170, size: 11, font, color: INK });
  page.drawLine({ start: { x: 100, y: 165 }, end: { x: 240, y: 165 }, thickness: 0.9, color: INK });
  fs.writeFileSync(path.join(OUT, 'form.pdf'), await doc.save());
}

async function invoice() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Invoice 2026-041', { x: 60, y: 770, size: 18, font: bold, color: INK });
  page.drawText('Web development, October 2026', { x: 60, y: 745, size: 11, font, color: INK });
  page.drawText('Total: 1,240.00 EUR', { x: 60, y: 715, size: 13, font: bold, color: INK });
  page.drawText('Signature:', { x: 60, y: 160, size: 11, font, color: INK });
  page.drawLine({ start: { x: 130, y: 155 }, end: { x: 330, y: 155 }, thickness: 0.9, color: INK });
  fs.writeFileSync(path.join(OUT, 'invoice.pdf'), await doc.save());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await contract();
  await form();
  await invoice();
  console.log('fixtures written to', OUT);
})();
