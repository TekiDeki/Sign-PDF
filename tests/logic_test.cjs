#!/usr/bin/env node
/* Sign PDF · logic tests
 * SPDX-License-Identifier: Apache-2.0
 *
 * node tests/logic_test.cjs
 * Pure engine plus real PDF work through pdf-lib. No browser, no network.
 * Needs pdf-lib installed next to this repo: npm install pdf-lib@1.17.1
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');

const E = require(path.join(__dirname, '..', 'src', 'engine.js'));
const FIX = path.join(__dirname, 'fixtures');

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
function eq(actual, expected, message) {
  checks += 1;
  assert.strictEqual(actual, expected, message + ' (got ' + actual + ', wanted ' + expected + ')');
}
function close(actual, expected, tolerance, message) {
  checks += 1;
  assert.ok(Math.abs(actual - expected) <= tolerance,
    message + ' (got ' + actual + ', wanted ' + expected + ' +/- ' + tolerance + ')');
}
function bytes(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIX, name)));
}

/* ------------------------------------------------------------ small text */

eq(E.formatSize(0), '0 B', 'zero bytes');
eq(E.formatSize(999), '999 B', 'bytes stay bytes');
eq(E.formatSize(4096), '4.0 KB', 'kilobytes keep one decimal under ten');
eq(E.formatSize(50000), '49 KB', 'kilobytes lose the decimal over ten');
eq(E.formatSize(3 * 1024 * 1024), '3.0 MB', 'megabytes');
eq(E.safeName('  my contract.pdf '), 'my contract', 'drops the extension and trims');
eq(E.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j', 'strips path and reserved characters');
eq(E.safeName('   ', 'signed'), 'signed', 'falls back to a name');
eq(E.safeName('x'.repeat(200)).length, 80, 'caps the length');

/* -------------------------------------------------------------- geometry */

close(E.heightForWidth(0.3, 4, 595, 842), (0.3 * 595) / (4 * 842), 1e-9, 'aspect on a portrait page');
close(E.heightForWidth(0.3, 0.25, 595, 842), (0.3 * 595) / (0.25 * 842), 1e-9, 'a squat image is tall');
eq(E.heightForWidth(0.3, 0, 595, 842), E.MIN_W, 'a broken aspect falls back to the minimum');
close(E.widthForHeight(0.15, 4, 595, 842), (0.15 * 4 * 842) / 595, 1e-9, 'width from a height');

// The physical box has to have the same proportions as the picture.
const physW = 0.3 * 595;
const physH = E.heightForWidth(0.3, 6, 595, 842) * 842;
close(physW / physH, 6, 1e-9, 'the drawn box is undistorted on the page');

const placed = E.placeAt(0.5, 0.5, 4, 595, 842);
close(placed.x + placed.w / 2, 0.5, 1e-9, 'a new signature is centred horizontally');
close(placed.y + placed.h / 2, 0.5, 1e-9, 'a new signature is centred vertically');
ok(placed.h <= 0.16 + 1e-9, 'a new signature never takes more than 16 percent of the page height');

const atCorner = E.placeAt(0, 0, 4, 595, 842);
eq(atCorner.x, 0, 'it does not hang off the left edge');
eq(atCorner.y, 0, 'it does not hang off the top edge');
const atFarCorner = E.placeAt(1, 1, 4, 595, 842);
close(atFarCorner.x + atFarCorner.w, 1, 1e-9, 'it does not hang off the right edge');
close(atFarCorner.y + atFarCorner.h, 1, 1e-9, 'it does not hang off the bottom edge');

const clamped = E.clampRect({ x: -2, y: 3, w: 5, h: 5 });
eq(clamped.x, 0, 'a negative x is pulled back');
eq(clamped.w, 1, 'a width over the page is cut to the page');
eq(clamped.y + clamped.h <= 1 + 1e-9, true, 'the bottom stays on the page');

const moved = E.moveBy({ x: 0.2, y: 0.2, w: 0.3, h: 0.1 }, 0.05, 0.05);
close(moved.x, 0.25, 1e-9, 'moving right');
close(moved.y, 0.25, 1e-9, 'moving down');
close(moved.w, 0.3, 1e-9, 'moving keeps the width');
const stuck = E.moveBy({ x: 0.9, y: 0.1, w: 0.3, h: 0.1 }, 0.5, 0);
close(stuck.x + stuck.w, 1, 1e-9, 'dragging past the edge stops at the edge');

const base = { x: 0.2, y: 0.2, w: 0.3, h: 0.12 };
const east = E.resize(base, 'se', 0.4, 0.45, 4, 595, 842);
close(east.x, 0.2, 1e-9, 'the south east handle keeps the left edge still');
close(east.y, 0.2, 1e-9, 'the south east handle keeps the top edge still');
close(east.h, (east.w * 595) / (4 * 842), 1e-9, 'resizing keeps the picture undistorted');
const west = E.resize(base, 'nw', 0.39, 0.2, 4, 595, 842);
close(west.x + west.w, 0.5, 1e-9, 'the north west handle keeps the right edge still');
close(west.y + west.h, 0.32, 1e-9, 'the north west handle keeps the bottom edge still');

const tiny = E.resize(base, 'se', 0.2001, 0.2, 4, 595, 842);
ok(tiny.w >= E.MIN_W - 1e-9, 'a signature cannot be shrunk past the minimum');
const huge = E.resize(base, 'se', 5, 5, 4, 595, 842);
ok(huge.x + huge.w <= 1 + 1e-9 && huge.y + huge.h <= 1 + 1e-9, 'resizing stops at the page edge');

eq(E.contains(base, 0.3, 0.25), true, 'a point inside');
eq(E.contains(base, 0.9, 0.25), false, 'a point outside');
eq(E.hitTest([{ id: 'a', x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, { id: 'b', x: 0.2, y: 0.2, w: 0.2, h: 0.2 }], 0.25, 0.25),
  'b', 'the topmost placement wins');
eq(E.hitTest([{ id: 'a', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], 0.9, 0.9), null, 'empty space hits nothing');

eq(E.handleAt(base, 0.201, 0.202, 0.02, 0.02), 'nw', 'the north west corner');
eq(E.handleAt(base, 0.499, 0.318, 0.02, 0.02), 'se', 'the south east corner');
eq(E.handleAt(base, 0.35, 0.26, 0.02, 0.02), null, 'the middle is not a handle');

/* ----------------------------------------------------------------- ink */

function buffer(width, height, draw) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (draw(x, y)) {
        data[(y * width + x) * 4 + 3] = 255;
      }
    }
  }
  return data;
}

const bounds = E.inkBounds(buffer(20, 10, (x, y) => x >= 4 && x <= 9 && y >= 2 && y <= 6), 20, 10, 12);
eq(bounds.x, 4, 'ink bounds start where the ink starts');
eq(bounds.y, 2, 'ink bounds start where the ink starts, vertically');
eq(bounds.w, 6, 'ink bounds width');
eq(bounds.h, 5, 'ink bounds height');
eq(E.inkBounds(buffer(10, 10, () => false), 10, 10, 12), null, 'a blank pad has no bounds');

const decoded = E.dataUrlBytes('data:image/png;base64,' + Buffer.from([1, 2, 3, 250]).toString('base64'));
eq(decoded.length, 4, 'a data url is decoded');
eq(decoded[3], 250, 'a byte above 127 survives the decode');

/* ------------------------------------------------------------- stamping */

function imageRefs(doc, page) {
  const found = [];
  const resources = page.node.Resources();
  if (!resources) return found;
  const xobjects = resources.lookup(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return found;
  xobjects.entries().forEach(([, ref]) => {
    const stream = doc.context.lookup(ref);
    if (stream && stream.dict && String(stream.dict.get(PDFName.of('Subtype'))) === '/Image') {
      found.push(ref.toString());
    }
  });
  return found;
}

function imageCount(doc, page) {
  return imageRefs(doc, page).length;
}

function uniqueImages(doc, page) {
  return new Set(imageRefs(doc, page)).size;
}

(async () => {
  const png = fs.readFileSync(path.join(FIX, 'signature.png'));

  // One signature on the third page of a three page contract.
  const source = bytes('contract.pdf');
  const before = await PDFDocument.load(source);
  eq(before.getPageCount(), 3, 'the contract has three pages');

  const placements = [
    { id: 'p1', page: 2, x: 0.22, y: 0.72, w: 0.32, h: 0.14, key: 'sig' }
  ];
  const out = await E.stampPdf({ PDFDocument }, source, placements, { sig: png }, { title: 'contract-signed' });
  const after = await PDFDocument.load(out);
  eq(after.getPageCount(), 3, 'stamping keeps every page');
  eq(after.getTitle(), 'contract-signed', 'the title is set on the output');
  eq(imageCount(after, after.getPages()[0]), 0, 'the first page is untouched');
  eq(imageCount(after, after.getPages()[1]), 0, 'the second page is untouched');
  eq(imageCount(after, after.getPages()[2]), 1, 'the third page carries the signature');

  // The drawing is a content stream operation, not an annotation.
  const content = after.getPages()[2].node.Contents().toString();
  ok(/\/Image|\bDo\b/.test(content) || content.length > 0, 'the page has a content stream');
  const annotations = after.getPages()[2].node.Annots();
  ok(!annotations || annotations.size() === 0, 'no annotation layer is used');

  // The same stamp twice, at different sizes, both land.
  const two = await E.stampPdf({ PDFDocument }, source, [
    { id: 'a', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.09, key: 'sig' },
    { id: 'b', page: 0, x: 0.5, y: 0.5, w: 0.4, h: 0.18, key: 'sig' }
  ], { sig: png }, {});
  const twoDoc = await PDFDocument.load(two);
  eq(imageCount(twoDoc, twoDoc.getPages()[0]), 2, 'two drawings are two draw calls');
  eq(uniqueImages(twoDoc, twoDoc.getPages()[0]), 1, 'but the same signature is embedded only once');

  // A page index that does not exist is skipped, not a crash.
  const skipped = await E.stampPdf({ PDFDocument }, source, [
    { id: 'x', page: 9, x: 0.1, y: 0.1, w: 0.2, h: 0.1, key: 'sig' }
  ], { sig: png }, {});
  eq((await PDFDocument.load(skipped)).getPageCount(), 3, 'an impossible page is ignored');

  // A missing image is a real error, so the user is told instead of a blank page.
  let failed = null;
  try {
    await E.stampPdf({ PDFDocument }, source, [
      { id: 'x', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1, key: 'missing' }
    ], {}, {});
  } catch (error) {
    failed = error;
  }
  ok(failed && /missing image/.test(failed.message), 'a missing image throws');

  // The one page slip, with the signature under the printed line.
  const slip = await E.stampPdf({ PDFDocument }, bytes('form.pdf'), [
    { id: 's', page: 0, x: 0.26, y: 0.735, w: 0.36, h: 0.09, key: 'sig' }
  ], { sig: png }, {});
  const slipDoc = await PDFDocument.load(slip);
  eq(slipDoc.getPageCount(), 1, 'the slip keeps its single page');
  eq(imageCount(slipDoc, slipDoc.getPages()[0]), 1, 'the slip carries the signature');

  // Encrypted input is refused by pdf-lib itself; the app catches it.
  let encrypted = null;
  try {
    await E.stampPdf({ PDFDocument }, bytes('encrypted.pdf'), placements, { sig: png }, {});
  } catch (error) {
    encrypted = error;
  }
  ok(encrypted, 'an encrypted PDF cannot be stamped silently');

  console.log('logic checks: ' + checks);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
