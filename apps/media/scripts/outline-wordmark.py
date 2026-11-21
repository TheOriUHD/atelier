#!/usr/bin/env python3
"""
Turns the wordmark "Atelier" into outlines, so the logo files need no font: Source Serif 4 at weight 600 and optical size 28
(what the website's header uses, `font: 600 1.375rem var(--serif)`, with -0.01em letter-spacing), shaped with HarfBuzz so the
kerning is right. Writes src/wordmark.json: the path (y down, origin at the baseline), its advance width and the font's metrics.
One-off; the result is committed, so building the kit needs no Python:

  python3 -m venv /tmp/fvenv && /tmp/fvenv/bin/pip install fonttools brotli uharfbuzz
  /tmp/fvenv/bin/python apps/media/scripts/outline-wordmark.py
"""
import io, json, sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

root = Path(__file__).resolve().parents[1]
font_file = root.parents[1] / "apps/site/public/fonts/source-serif-4-latin-opsz-normal.woff2"
TEXT, WGHT, OPSZ, TRACKING = "Atelier", 600, 28, -0.01

tt = TTFont(str(font_file))
upem = tt["head"].unitsPerEm
# Shape with the variable font (HarfBuzz applies the variations to the kerning too), draw from an instance of it.
buf = io.BytesIO()
tt.flavor = None
tt.save(buf)
blob = hb.Blob(buf.getvalue())
face = hb.Face(blob)
font = hb.Font(face)
font.set_variations({"wght": WGHT, "opsz": OPSZ})
hbbuf = hb.Buffer()
hbbuf.add_str(TEXT)
hbbuf.guess_segment_properties()
hb.shape(font, hbbuf, {"kern": True, "liga": True})

inst = instancer.instantiateVariableFont(TTFont(io.BytesIO(buf.getvalue())), {"wght": WGHT, "opsz": OPSZ})
glyph_set = inst.getGlyphSet()
order = inst.getGlyphOrder()
pen = SVGPathPen(glyph_set, ntos=lambda v: ("%.2f" % v).rstrip("0").rstrip("."))
x = 0.0
track = TRACKING * upem
infos, positions = hbbuf.glyph_infos, hbbuf.glyph_positions
for i, (info, pos) in enumerate(zip(infos, positions)):
    name = order[info.codepoint]
    # y up in the font; the SVG's y goes down.
    glyph_set[name].draw(TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset)))
    x += pos.x_advance + (track if i < len(infos) - 1 else 0)

os2 = inst["OS/2"]
out = {
    "text": TEXT,
    "font": "Source Serif 4, weight 600, optical size 28, letter-spacing -0.01em",
    "unitsPerEm": upem,
    "width": round(x, 2),
    "ascent": inst["hhea"].ascent,
    "descent": inst["hhea"].descent,
    "capHeight": os2.sCapHeight,
    "xHeight": os2.sxHeight,
    "d": pen.getCommands(),
}
(root / "src/wordmark.json").write_text(json.dumps(out, indent=1) + "\n")
print(f"width {out['width']} of {upem} upem, cap height {out['capHeight']}, x height {out['xHeight']}, {len(out['d'])} chars of path")
