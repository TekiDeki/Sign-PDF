#!/usr/bin/env python3
# Sign PDF · end to end tests
# SPDX-License-Identifier: Apache-2.0
"""Drives index.html on a desktop, a touch tablet and a touch phone.

    python3 tests/ui_test.py                  # Chromium
    BROWSER=firefox python3 tests/ui_test.py  # Firefox
    BROWSER=webkit python3 tests/ui_test.py   # WebKit

Starts its own static server on a free port, so no other process is needed.
Downloads are captured and read back through pdf-lib, so the PDF that the user
would get is the one that gets checked, not a mock of it.
"""
from __future__ import annotations

import functools
import json
import os
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"
OUT = ROOT / "tests" / "out"
BROWSER = os.environ.get("BROWSER", "chromium").strip().lower()
checks = 0


def check(condition, message):
    global checks
    checks += 1
    if not condition:
        raise AssertionError(message)


def context_options(**options):
    """Firefox refuses is_mobile, so the phone pass drops it there."""
    if BROWSER == "firefox":
        options.pop("is_mobile", None)
    return options


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Server:
    def __init__(self, directory: Path):
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/index.html"


class Watcher:
    """Collects console and page errors for one page."""

    def __init__(self, page):
        self.problems = []
        page.on("console", self._console)
        page.on("pageerror", lambda error: self.problems.append("pageerror: " + str(error)))

    def _console(self, message):
        if message.type in ("error", "warning"):
            self.problems.append("console " + message.type + ": " + message.text)

    def quiet(self, label):
        check(not self.problems, label + " raised " + repr(self.problems))


def inspect_pdf(path: Path) -> dict:
    result = subprocess.run(
        ["node", str(ROOT / "tests" / "inspect.cjs"), str(path)],
        capture_output=True, text=True, timeout=120,
        env=dict(os.environ, NODE_PATH=os.environ.get("NODE_PATH", "/tmp/pdftest/node_modules")),
    )
    check(result.returncode == 0, f"{path.name} is unreadable: {result.stderr.strip()}")
    return json.loads(result.stdout.strip().splitlines()[-1])


def open_app(context, url):
    page = context.new_page()
    watcher = Watcher(page)
    page.goto(url, wait_until="load")
    page.wait_for_function("window.__signpdf && document.querySelector('#drawCanvas')")
    return page, watcher


def upload(page, name: str):
    page.set_input_files("#fileInput", str(FIX / name))
    page.wait_for_function("document.querySelectorAll('#pageList .page').length > 0", timeout=20000)
    page.wait_for_timeout(450)


def state(page) -> dict:
    return page.evaluate("window.__signpdf.state()")


def box_of(page, selector: str):
    """Scroll the element into view first: bounding boxes are viewport based,
    and a click outside the viewport lands nowhere."""
    locator = page.locator(selector)
    locator.scroll_into_view_if_needed()
    page.wait_for_timeout(120)
    return locator.bounding_box()


def draw_signature(page):
    box = box_of(page, "#drawCanvas")
    check(box is not None, "the drawing pad has no box")
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cx - 90, cy + 20)
    page.mouse.down()
    for step in range(1, 26):
        page.mouse.move(cx - 90 + step * 6, cy + 20 - (18 if step % 3 else -14))
    page.mouse.up()
    page.click("#drawUse")
    page.wait_for_timeout(150)


def click_page(page, index: int, nx: float, ny: float):
    box = box_of(page, f'.overlay[data-page="{index}"]')
    check(box is not None, f"page {index} has no box")
    page.mouse.click(box["x"] + box["width"] * nx, box["y"] + box["height"] * ny)
    page.wait_for_timeout(120)


def place_signature(page, index: int, nx: float, ny: float):
    click_page(page, index, nx, ny)
    page.wait_for_timeout(200)
    current = state(page)
    check(current["placements"], f"no placement was created on page {index}")
    return current["placements"][-1]


def export_and_read(page, path: Path) -> dict:
    with page.expect_download(timeout=30000) as info:
        page.click("#exportBtn")
    download = info.value
    download.save_as(str(path))
    page.wait_for_timeout(200)
    return inspect_pdf(path)


def run(pw, label: str, options: dict):
    browser = getattr(pw, BROWSER).launch()
    context = browser.new_context(**context_options(**options))
    try:
        with Server(ROOT) as server:
            page, watcher = open_app(context, server.url)

            # 1. The page loads clean and bilingual headings are in place.
            check(page.locator("h1").inner_text().strip() != "", f"{label}: no heading")
            check(page.evaluate("document.documentElement.lang") == "en", f"{label}: wrong default language")

            # 2. Drop a three page contract.
            upload(page, "contract.pdf")
            check(page.locator("#pageList .page").count() == 3, f"{label}: the contract did not render three pages")
            meta = page.locator("#docMeta").inner_text()
            check("3" in meta, f"{label}: the page count is missing from the header: {meta!r}")

            # 3. Draw a signature and put it on page 3.
            draw_signature(page)
            check(state(page)["signature"], f"{label}: the drawn signature was not kept")
            placed = place_signature(page, 2, 0.62, 0.76)
            check(placed["page"] == 2, f"{label}: the signature landed on the wrong page")
            check(0.4 < placed["x"] < 0.8, f"{label}: the signature x is off: {placed['x']}")
            check(0.6 < placed["y"] < 0.9, f"{label}: the signature y is off: {placed['y']}")
            check(page.locator(".place.is-selected").count() == 1, f"{label}: the new signature is not selected")
            check(page.locator(".place .handle").count() == 4, f"{label}: the corner handles are missing")

            # 4. Drag it, then resize it from a corner.
            overlay_box = box_of(page, '.overlay[data-page="2"]')
            before = state(page)["placements"][-1]
            page.mouse.move(overlay_box["x"] + overlay_box["width"] * (before["x"] + before["w"] / 2),
                            overlay_box["y"] + overlay_box["height"] * (before["y"] + before["h"] / 2))
            page.mouse.down()
            page.mouse.move(overlay_box["x"] + overlay_box["width"] * (before["x"] + before["w"] / 2 - 0.1),
                            overlay_box["y"] + overlay_box["height"] * (before["y"] + before["h"] / 2 - 0.05),
                            steps=8)
            page.mouse.up()
            page.wait_for_timeout(150)
            moved = state(page)["placements"][-1]
            check(moved["x"] < before["x"] - 0.02, f"{label}: dragging did not move the signature")
            check(abs(moved["w"] - before["w"]) < 1e-6, f"{label}: dragging changed the size")

            corner_x = overlay_box["x"] + overlay_box["width"] * (moved["x"] + moved["w"])
            corner_y = overlay_box["y"] + overlay_box["height"] * (moved["y"] + moved["h"])
            page.mouse.move(corner_x, corner_y)
            page.mouse.down()
            page.mouse.move(corner_x - overlay_box["width"] * 0.08, corner_y, steps=6)
            page.mouse.up()
            page.wait_for_timeout(150)
            resized = state(page)["placements"][-1]
            check(resized["w"] < moved["w"] - 0.01, f"{label}: the corner handle did not resize")
            ratio_before = moved["w"] / moved["h"]
            ratio_after = resized["w"] / resized["h"]
            check(abs(ratio_before - ratio_after) / ratio_before < 0.02, f"{label}: resizing distorted the signature")

            # 5. A date on page 1.
            page.click("#dateBtn")
            place_signature(page, 0, 0.3, 0.2)
            check(len(state(page)["placements"]) == 2, f"{label}: the date did not land")

            # 6. Undo removes the date, and only the date.
            page.click("#undoBtn")
            page.wait_for_timeout(150)
            after_undo = state(page)["placements"]
            check(len(after_undo) == 1, f"{label}: undo removed the wrong number of items")

            # 7. Export and read the file back.
            OUT.mkdir(parents=True, exist_ok=True)
            target = OUT / f"signed-{label}.pdf"
            summary = export_and_read(page, target)
            check(summary["pages"] == 3, f"{label}: the export lost pages: {summary}")
            check(summary["images"][2]["images"] >= 1, f"{label}: page 3 has no image in the export: {summary}")
            check(summary["images"][0]["images"] == 0, f"{label}: page 1 should be clean after undo: {summary}")
            check(target.stat().st_size > 2000, f"{label}: the export is suspiciously small")

            # 8. A reload keeps the language and the signature, not the document.
            page.reload(wait_until="load")
            page.wait_for_function("window.__signpdf")
            check(page.locator("#sigPreview").is_visible(), f"{label}: the signature was forgotten on reload")
            check(page.locator("#pageList .page").count() == 0, f"{label}: a document survived the reload")

            # 9. Switching language translates the page and the page labels.
            upload(page, "form.pdf")
            page.select_option("#langSelect", "ro")
            page.wait_for_timeout(200)
            check(page.evaluate("document.documentElement.lang") == "ro", f"{label}: the language did not change")
            label_text = page.locator(".page-no").first.inner_text().strip().lower()
            check(label_text.startswith("pagina"), f"{label}: page labels did not follow the language: {label_text!r}")
            check("Semnează" in page.locator("h1").inner_text(), f"{label}: the heading is still English")
            page.select_option("#langSelect", "sr-cyrl")
            page.wait_for_timeout(200)
            cyr = page.locator("h1").inner_text()
            check(any("\u0400" <= char <= "\u04ff" for char in cyr), f"{label}: Cyrillic did not load: {cyr!r}")
            page.select_option("#langSelect", "en")

            # 10. A password protected PDF is refused with a sentence, not a crash.
            page.set_input_files("#fileInput", str(FIX / "encrypted.pdf"))
            page.wait_for_timeout(1200)
            toast = page.locator("#toast").inner_text()
            check("password" in toast.lower(), f"{label}: no clear message for an encrypted PDF: {toast!r}")

            # 11. A broken file is refused the same way.
            page.set_input_files("#fileInput", str(FIX / "broken.pdf"))
            page.wait_for_timeout(1200)
            toast = page.locator("#toast").inner_text()
            check(toast.strip() != "", f"{label}: no message for a broken file")

            # 12. Touch: a tap on a page places a pending signature.
            if options.get("has_touch"):
                page.click("#dateBtn")
                overlay = box_of(page, '.overlay[data-page="0"]')
                page.touchscreen.tap(overlay["x"] + overlay["width"] * 0.5,
                                     overlay["y"] + overlay["height"] * 0.5)
                page.wait_for_timeout(200)
                check(len(state(page)["placements"]) == 1, f"{label}: a tap did not place the date")

            # 13. On a narrow screen the signature panel sits above the pages,
            # and nothing sticks out sideways.
            if options.get("is_mobile") and options["viewport"]["width"] < 700:
                panel_top = box_of(page, "#panel")["y"]
                page_top = box_of(page, ".page")["y"]
                check(panel_top < page_top, f"{label}: the panel is below the pages on a phone")
                overflow = page.evaluate(
                    "document.documentElement.scrollWidth - document.documentElement.clientWidth")
                check(overflow <= 1, f"{label}: the page scrolls sideways by {overflow}px")

            watcher.quiet(label)
            print(f"{label}: ok")
    finally:
        context.close()
        browser.close()


def main():
    with sync_playwright() as pw:
        run(pw, "desktop", {"viewport": {"width": 1280, "height": 900}})
        run(pw, "tablet", {"viewport": {"width": 820, "height": 1180}, "is_mobile": True, "has_touch": True})
        run(pw, "phone", {"viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True,
                          "device_scale_factor": 2})
    print(f"{BROWSER}: {checks} checks")


if __name__ == "__main__":
    main()
