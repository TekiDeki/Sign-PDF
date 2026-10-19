#!/usr/bin/env node
/* Prints the page count of a PDF, using the same library the app ships.
 * pdf-lib compresses the page tree into object streams, so a regex over the
 * bytes cannot count the pages. This is the honest way to check a download. */
'use strict';
const fs = require('node:fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: pagecount.cjs <file.pdf>');
    process.exit(2);
  }
  const doc = await PDFDocument.load(fs.readFileSync(target));
  console.log(doc.getPageCount());
})().catch((error) => {
  console.error('cannot read', process.argv[2], error.message);
  process.exit(1);
});
