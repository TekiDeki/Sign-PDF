#!/usr/bin/env node
/* Prints a small JSON summary of a PDF: page count, and how many images are
 * drawn on each page. Used by the UI test to prove the signature really
 * landed in the page content and not only on the screen.
 *
 *   node tests/inspect.cjs <file.pdf>
 */
'use strict';

const fs = require('node:fs');
const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');

(async () => {
  const doc = await PDFDocument.load(fs.readFileSync(process.argv[2]));
  const pages = doc.getPages().map((page, index) => {
    let images = 0;
    const names = [];
    const resources = page.node.Resources();
    if (resources) {
      const xobjects = resources.lookup(PDFName.of('XObject'), PDFDict);
      if (xobjects) {
        xobjects.entries().forEach(([, ref]) => {
          const stream = doc.context.lookup(ref);
          if (stream && stream.dict && String(stream.dict.get(PDFName.of('Subtype'))) === '/Image') {
            images += 1;
            names.push(ref.toString());
          }
        });
      }
    }
    return { page: index, images: images, unique: new Set(names).size };
  });
  console.log(JSON.stringify({
    pages: doc.getPageCount(),
    title: doc.getTitle() || '',
    images: pages
  }));
})().catch((error) => {
  console.error('cannot read', process.argv[2], error.message);
  process.exit(1);
});
