#!/usr/bin/env python3
# Sign PDF - TekiDeki
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Kristian Mario Miskovic (TekiDeki)
"""Build a single self contained index.html.

Deterministic by design: the same sources always give byte identical output,
with no timestamps, no dictionary ordering surprises and no machine paths.

The fourth locale, Serbian Cyrillic, is never written by hand. It is produced
here by transliterating the Serbian Latin strings, so the two always agree.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
TEMPLATE = SRC / "template.html"
STYLES = SRC / "styles.css"
ENGINE_JS = SRC / "engine.js"
APP_JS = SRC / "app.js"
LOCALES = SRC / "i18n" / "locales.json"
VENDORS = (
    SRC / "vendor" / "pdf-lib.min.js",
    SRC / "vendor" / "pdf.min.js",
)
WORKER = SRC / "vendor" / "pdf.worker.min.js"
OUT = ROOT / "index.html"
VERSION_FILE = ROOT / "VERSION"

AUTHORED = ("en", "ro", "sr-latn")
ALL_LOCALES = ("en", "ro", "sr-latn", "sr-cyrl")

# Terms that stay in Latin script inside the Cyrillic locale.
KEEP_LATIN = (
    "Sign PDF",
    "TekiDeki",
    "freehtml.dev",
    "Apache-2.0",
    "PDF",
    "PNG",
    "JPG",
)

NON_SERBIAN = set("qwxQ WX".replace(" ", ""))

DIGRAPHS = {"lj": "љ", "nj": "њ", "dž": "џ"}
LETTERS = {
    "a": "а", "b": "б", "c": "ц", "č": "ч", "ć": "ћ", "d": "д", "đ": "ђ",
    "e": "е", "f": "ф", "g": "г", "h": "х", "i": "и", "j": "ј", "k": "к",
    "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "r": "р", "s": "с",
    "š": "ш", "t": "т", "u": "у", "v": "в", "z": "з", "ž": "ж",
}

PLACEHOLDER_RE = re.compile(r"\{[a-zA-Z]+\}")
FORBIDDEN = {"\u2013": "en dash", "\u2014": "em dash", "\u00a0": "no-break space"}


class BuildError(SystemExit):
    pass


def fail(message: str) -> None:
    raise BuildError("build failed: " + message)


def read(path: Path) -> str:
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        fail(f"{path.name} starts with a byte order mark")
    return data.decode("utf-8")


def check_text(name: str, text: str) -> None:
    for char, label in FORBIDDEN.items():
        if char in text:
            line = text[: text.index(char)].count("\n") + 1
            fail(f"{name} contains a {label} on line {line}")
    if "\ufffd" in text:
        fail(f"{name} contains a replacement character")


def transliterate(text: str) -> str:
    """Serbian Latin to Cyrillic, leaving {placeholders} and kept terms alone."""
    if not text:
        return text

    protected: list[str] = []

    def keep(value: str) -> str:
        protected.append(value)
        return f"\x00{len(protected) - 1}\x00"

    work = PLACEHOLDER_RE.sub(lambda match: keep(match.group(0)), text)
    for term in sorted(KEEP_LATIN, key=len, reverse=True):
        work = work.replace(term, keep(term))

    out: list[str] = []
    index = 0
    lowered = work.lower()
    while index < len(work):
        pair = lowered[index: index + 2]
        if pair in DIGRAPHS:
            cyr = DIGRAPHS[pair]
            out.append(cyr.upper() if work[index].isupper() else cyr)
            index += 2
            continue
        char = work[index]
        lower = char.lower()
        if lower in LETTERS:
            cyr = LETTERS[lower]
            out.append(cyr.upper() if char.isupper() else cyr)
        else:
            out.append(char)
        index += 1

    result = "".join(out)
    for position, value in enumerate(protected):
        result = result.replace(f"\x00{position}\x00", value)
    return result


def leftovers(text: str) -> set[str]:
    """Latin letters that survived transliteration and should not have."""
    work = PLACEHOLDER_RE.sub(" ", text)
    for term in sorted(KEEP_LATIN, key=len, reverse=True):
        work = work.replace(term, " ")
    return {char for char in work if char.isascii() and char.isalpha() and char not in NON_SERBIAN}


def load_locales() -> dict[str, dict[str, str]]:
    try:
        data = json.loads(read(LOCALES))
    except json.JSONDecodeError as error:
        fail(f"locales.json is not valid JSON: {error}")
    for locale in AUTHORED:
        if locale not in data:
            fail(f"locales.json is missing the {locale} block")
    reference = set(data["en"])
    for locale in AUTHORED:
        keys = set(data[locale])
        if keys != reference:
            missing = sorted(reference - keys)
            extra = sorted(keys - reference)
            fail(f"{locale} key set differs (missing {missing[:6]}, extra {extra[:6]})")
    placeholders = lambda value: frozenset(PLACEHOLDER_RE.findall(value))
    for key in reference:
        expected = placeholders(data["en"][key])
        for locale in AUTHORED:
            if placeholders(data[locale][key]) != expected:
                fail(f"placeholder mismatch for {key} in {locale}")
    data["sr-cyrl"] = {key: transliterate(data["sr-latn"][key]) for key in data["sr-latn"]}
    for locale in ALL_LOCALES:
        for key, value in data[locale].items():
            if not isinstance(value, str) or not value.strip():
                fail(f"empty or non string value for {key} in {locale}")
            check_text(f"locales.json {locale}.{key}", value)
    for key, value in data["sr-cyrl"].items():
        bad = leftovers(value)
        if bad:
            fail(f"sr-cyrl.{key} still has Latin letters {sorted(bad)}: {value}")
    return data


def build() -> str:
    version = read(VERSION_FILE).strip()
    if not re.fullmatch(r"\d+(\.\d+)*", version):
        fail("VERSION must be a dotted number")

    template = read(TEMPLATE)
    styles = read(STYLES)
    engine_js = read(ENGINE_JS)
    app_js = read(APP_JS)
    for name, text in (("template.html", template), ("styles.css", styles),
                       ("engine.js", engine_js), ("app.js", app_js)):
        check_text(name, text)

    vendor_js = [read(path) for path in VENDORS]
    worker_js = read(WORKER)

    # A closing script tag inside an inlined script would end the tag early
    # and silently break the page, so every bundle is checked at build time.
    for path, text in list(zip(VENDORS, vendor_js)) + [("engine.js", engine_js), ("app.js", app_js)]:
        name = path.name if hasattr(path, "name") else path
        if "</script" in text.lower():
            fail(f"{name} contains a literal closing script tag")
    if "</script" in worker_js.lower():
        fail("pdf.worker.min.js contains a literal closing script tag")

    locales = load_locales()

    used = set(re.findall(r'data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"', template))
    used |= set(re.findall(r"\bt\(['\"]([A-Za-z0-9]+)['\"]", app_js))
    missing = sorted(key for key in used if key not in locales["en"])
    if missing:
        fail(f"template or app uses unknown keys: {missing}")

    for locale in ALL_LOCALES:
        if f'<option value="{locale}">' not in template:
            fail(f"the language selector is missing {locale}")

    payload = ",\n".join(
        "  " + json.dumps(locale) + ": " + json.dumps(locales[locale], ensure_ascii=False, sort_keys=True)
        for locale in ALL_LOCALES
    )
    locales_js = ("/* Generated by build.py from src/i18n/locales.json. Do not edit. */\n"
                  "window.TD_LOCALES = {\n" + payload + "\n};\n")
    if "</script" in locales_js.lower():
        fail("a locale string contains a literal closing script tag")

    html = template
    style_tag = '<link rel="stylesheet" href="styles.css">'
    if style_tag not in html:
        fail("template is missing the stylesheet link")
    html = html.replace(style_tag, "<style>\n" + styles.rstrip() + "\n</style>", 1)

    for src, body in (
        ('<script src="vendor/pdf-lib.min.js"></script>', vendor_js[0]),
        ('<script src="vendor/pdf.min.js"></script>', vendor_js[1]),
        ('<script id="pdfWorkerSource" type="text/plain"></script>',
         '<script id="pdfWorkerSource" type="text/plain">' + worker_js + "</script>"),
        ('<script src="engine.js"></script>', engine_js),
        ('<script src="i18n/locales.js"></script>', locales_js),
        ('<script src="app.js"></script>', app_js),
    ):
        if src not in html:
            fail(f"template is missing {src}")
        html = html.replace(src, body if body.startswith('<script id="pdfWorkerSource"')
                            else "<script>\n" + body.rstrip() + "\n</script>", 1)

    html = html.replace('<html lang="en">', '<html lang="en" data-version="' + version + '">', 1)
    html = html.replace("</body>", "<!-- Sign PDF " + version + " - single file build -->\n</body>", 1)

    masked = html
    for body in vendor_js + [worker_js]:
        masked = masked.replace(body, "/* vendor */").replace(body.rstrip(), "/* vendor */")
    check_text("index.html", masked)
    if '<link rel="stylesheet"' in html or re.search(r'<script src="(?!https://)', html):
        fail("index.html still references a local asset")
    if not html.startswith("<!DOCTYPE html>"):
        fail("index.html must start with the doctype")

    OUT.write_text(html, encoding="utf-8")
    return html


def main() -> None:
    html = build()
    size = len(html.encode("utf-8"))
    locales = json.loads(read(LOCALES))
    print(f"index.html written, {size} bytes, {size / 1024:.1f} KiB")
    print(f"locales: {', '.join(ALL_LOCALES)} ({len(locales['en'])} keys each)")
    print(f"VERSION: {read(VERSION_FILE).strip()}")


if __name__ == "__main__":
    main()
