#!/usr/bin/env python3
"""Cuts the painted bodies in public/bodies from the art, all RGB on pure black. The assets
folder holds one subfolder per source:

    nebulae/   the research nebulae, wide paintings (research_01_blue_amber.png, ...,
               golden_butterfly_nebula.png, ...)
    coronas/   flame rings, 512 px (corona_01.png ... corona_06.png)
    stars/     four-pointed sparkle stars, 512 px (star_01.png ... star_06.png)
    planets/   one planet per render, named by family (see WORLDS)
    protostars/ six protostars on one sheet, three by two (source_sheet.png)
    sun/       the sun, a disc in curling flames (sun.png)
    decisions/ four-pointed stars, green/ and white_gray/ (emerald_compass_starburst.png, ...)
    pack/      the "Wayfinder Cozy Starchart" atlas pack, for the nurseries and the belt's
               stones

Most keep their paint, the black lifted into transparency. Bodies the engine colours by status
are written greyscale: the nurseries, the settled protostars, the decision stars neither green
nor white, the grey moons (tinted rust when stalled) and the nebulae a second time, for the
clouds coloured by palette (open questions, research ruled out). Everything is WebP, so the
folder stays small.

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install pillow numpy
    /tmp/venv/bin/python -I web/scripts/import-pack.py <assets dir> web/public/bodies
"""
import sys, os, numpy as np
from PIL import Image, ImageFilter

src, out = sys.argv[1], sys.argv[2]
S = 512


def rgb(path):
    return np.asarray(Image.open(os.path.join(src, path)).convert("RGB")).astype(np.float32) / 255


def radial(n=S):
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    return np.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2)


def smoothstep(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def save(img, name, q=88):
    img.save(os.path.join(out, name + ".webp"), "WEBP", quality=q, method=6)


# Brightness as the engine's palettes read it: mostly the strongest channel, so a saturated
# colour stays bright, pulled a little toward luminance so a pure blue isn't as bright as white.
def grey(a):
    return 0.7 * a.max(axis=2) + 0.3 * (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2])


def save_grey(a, name, fade=(0.78, 0.97)):
    g = np.clip(grey(a) * (1 - smoothstep(fade[0], fade[1], radial(a.shape[0]))), 0, 1)
    save(Image.fromarray((g * 255).astype(np.uint8)).convert("RGB"), name)


# Black lifted to transparency: alpha is the strongest channel, the colour divided back out of
# it, so the sprite composites the same over any sky as it did on black.
def unblack(a, alpha=None):
    al = a.max(axis=2) if alpha is None else alpha
    col = np.clip(a / np.maximum(al, 1e-3)[..., None], 0, 1)
    return Image.fromarray((np.dstack([col, al]) * 255).astype(np.uint8), "RGBA")


# Resampled so (cx, cy) lands at the centre, magnified by `scale`; black outside.
def shift(a, cx, cy, scale=1.0):
    im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
    half = S / 2 / scale
    box = (cx - half, cy - half, cx + half, cy + half)
    return np.asarray(im.transform((S, S), Image.EXTENT, box, Image.BICUBIC, fillcolor=(0, 0, 0))).astype(np.float32) / 255


# Research nebulae: wide paintings. Each is set in a square (the engine draws every body
# square) and written twice: in its own paint, and in greyscale for the clouds coloured by
# palette ("fog").
def nebula(i, a):
    w = a.shape[1]
    sq = np.zeros((w, w, 3), np.float32)
    o = (w - a.shape[0]) // 2
    sq[o:o + a.shape[0]] = a
    save(unblack(sq), f"nebula-{i + 1:02d}", q=86)
    g = np.clip(grey(sq), 0, 1)
    save(Image.fromarray((g * 255).astype(np.uint8)).convert("RGB"), f"fog-{i + 1:02d}", q=86)


# The first four are cut flat a little above their bottom edge, with a strip of a neighbouring
# painting along it in some: faded out inside a soft oval, which takes the cut and the strays
# with it.
CUT = ["research_01_blue_amber", "research_02_purple_magenta", "research_03_cyan", "research_04_ember"]
for i, name in enumerate(CUT):
    a = rgb(f"nebulae/{name}.png")
    h, w = a.shape[:2]
    oy, ox = np.nonzero(a.max(axis=2) > 0.05)
    top, bottom = oy.min(), oy.max()
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    cy = (top + bottom) / 2
    e = np.hypot((x - w / 2) / (w * 0.49), (y - cy) / ((bottom - top) / 2))
    keep = (1 - smoothstep(0.78, 1.0, e)) * (1 - smoothstep(bottom - 34, bottom - 8, y)) * smoothstep(top, top + 18, y)
    a = a * keep[..., None]
    nebula(i, np.roll(a, int(round(h / 2 - cy)), axis=0))

# The rest fade out on their own, with a wide black margin: cropped round the cloud so it spans
# as much of the square as the first four do, and brought to their size.
WHOLE = ["golden_butterfly_nebula", "luminous_teal_and_violet_spiral_nebula", "luminous_teal_nebula_stream", "rose_gold_spiral_nebula"]
for i, name in enumerate(WHOLE, len(CUT)):
    a = rgb(f"nebulae/{name}.png")
    oy, ox = np.nonzero(a.max(axis=2) > 0.05)
    cx, cy = (ox.min() + ox.max()) / 2, (oy.min() + oy.max()) / 2
    half = (ox.max() - ox.min()) / 0.86 / 2
    box = (cx - half, cy - half / 2, cx + half, cy + half / 2)
    im = Image.fromarray((a * 255).astype(np.uint8)).transform((768, 384), Image.EXTENT, box, Image.BICUBIC, fillcolor=(0, 0, 0))
    nebula(i, np.asarray(im).astype(np.float32) / 255)

# Coronas: flame rings pasted from a smaller crop, so the outer flames stop in a straight line at
# its box. Each ring is found by a circle fitted through its brightest pixels, its flames faded
# out before the nearest side of the box (the same distance all round), and it's recentred and
# scaled so every ring has radius RING of the half-width.
RING = 0.42
for i in range(1, 7):
    a = rgb(f"coronas/corona_{i:02d}.png")
    l = a.max(axis=2)
    ys, xs = np.nonzero(l > 0.85)
    fit = np.linalg.lstsq(np.c_[2 * xs, 2 * ys, np.ones(len(xs))], xs ** 2 + ys ** 2, rcond=None)[0]
    cx, cy, r = fit[0], fit[1], np.sqrt(fit[2] + fit[0] ** 2 + fit[1] ** 2)
    oy, ox = np.nonzero(l > 0.02)
    edge = min(cx - ox.min(), ox.max() - cx, cy - oy.min(), oy.max() - cy)
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    a = a * (1 - smoothstep(r + 0.45 * (edge - r), edge - 3, np.hypot(x - cx, y - cy)))[..., None]
    save(unblack(shift(a, cx, cy, RING * S / 2 / r)), f"corona-{i:02d}")

# Stars: some sit off centre (three of them 37 px high); each is moved so its core, the peak of
# its blurred brightness, is the centre.
for i in range(1, 7):
    a = rgb(f"stars/star_{i:02d}.png")
    l = np.asarray(Image.fromarray((a.max(axis=2) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32)
    ys, xs = np.nonzero(l > l.max() * 0.97)
    save(unblack(shift(a, xs.mean(), ys.mean())), f"star-{i:02d}")

# Planets: each render recut so its disc sits centred at radius DISC of the half-width (the
# engine's planet draw assumes it), the disc opaque and its atmosphere a glow fading out. The
# disc's edge is where brightness falls most steeply going out, so the glow isn't counted. The
# coloured sets as they are; the grey moons also in greyscale, the mono set the engine tints.
DISC = 0.816
WORLDS = {
    "red": ["red_01_incandescent_magma_world", "red_02_molten_crater_planet", "red_03_glowing_lava_world"],
    "yellow": ["yellow_01_golden_cratered_desert_planet", "yellow_02_painterly_desert_planet", "yellow_03_rocky_faults"],
    "gray": ["gray_01_cratered_moon", "gray_02_cratered_moonlit_planet", "gray_03_icy_cratered_moon"],
    "green": ["lush_emerald_planet_with_turquoise_seas", "lush_fantasy_world_in_space", "vibrant_emerald_fantasy_world"],
    "blue": ["luminous_blue_gas_giant", "oceanic_planet_with_swirling_clouds", "whimsical_ocean_world_planet"],
}


def world(name):
    im = Image.open(os.path.join(src, "planets", name + ".png")).convert("RGB")
    a = np.asarray(im).astype(np.float32) / 255
    l = a.max(axis=2)
    ys, xs = np.nonzero(l > 0.15)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    y, x = np.mgrid[0:l.shape[0], 0:l.shape[1]].astype(np.float32)
    d = np.hypot(x - cx, y - cy).astype(int)
    prof = np.bincount(d.ravel(), l.ravel()) / np.maximum(np.bincount(d.ravel()), 1)
    lo = int(0.3 * max(xs.max() - xs.min(), ys.max() - ys.min()))
    r = lo + int(np.argmin(np.diff(prof[lo:len(prof) - 2])))
    half = r / DISC
    crop = im.crop((round(cx - half), round(cy - half), round(cx + half), round(cy + half))).resize((S, S), Image.LANCZOS)
    return np.asarray(crop).astype(np.float32) / 255


disc = 1 - smoothstep(DISC * S / 2 - 2, DISC * S / 2 + 0.5, radial() * S / 2)
# A planet is never more than a few dozen pixels across on screen: 384 px is plenty.
small = lambda img: img.resize((384, 384), Image.LANCZOS)
for col, names in WORLDS.items():
    for i, name in enumerate(names):
        a = world(name)
        al = np.maximum(disc, a.max(axis=2) * (1 - disc))
        save(small(unblack(a, al)), f"planet-{col}-{i + 1:02d}", q=86)
        if col == "gray":
            g = grey(a)
            save(small(Image.fromarray((np.dstack([g, g, g, al]) * 255).astype(np.uint8), "RGBA")), f"planet-mono-{i + 1:02d}", q=86)

# The sun: recentred on its disc (found by its pale yellow, which the orange flames lack), which
# is then 0.67 of the half-width (SUN_DISC in the engine).
a = rgb("sun/sun.png")
hot = a[..., 1] > 0.65
cols, rows = np.nonzero(hot.mean(axis=0) > 0.25)[0], np.nonzero(hot.mean(axis=1) > 0.25)[0]
cx, cy, r = (cols.min() + cols.max()) / 2, (rows.min() + rows.max()) / 2, (cols.max() - cols.min() + rows.max() - rows.min()) / 4
save(unblack(shift(a, cx, cy, S / 2 * 0.67 / r)), "sun-01")

# Decision stars: four-pointed, three green and three white on wide black. Each is centred where
# its rays cross (its brightest point is off it, by up to 25 px, and its halo follows the rays)
# and scaled so its longest ray reaches TIP of the half-width, so every star is the same size
# whichever is drawn. The green and white keep their paint, at 256 px (a star is small on
# screen); the white are written a second time in greyscale ("decision-mono"), for the colours
# the pack doesn't have.
TIP = 0.95


# The mean position of the light in `band`, along the axis not summed.
def mean(band, axis):
    w = band.sum(axis=axis)
    return (np.arange(len(w)) * w).sum() / w.sum()


DECISIONS = {
    "green": ["emerald_compass_starburst", "emerald_starburst_waypoint", "neon_emerald_star_compass"],
    "white": ["minimal_four_pointed_star_glow", "centered_four_point_star_flare", "radiant_compass_star_on_black"],
}
for col, names in DECISIONS.items():
    for i, name in enumerate(names, 1):
        a = rgb(f"decisions/{'white_gray' if col == 'white' else col}/{name}.png")
        lum = a.max(axis=2)
        ys, xs = np.nonzero(lum > 0.05)
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        # Where the rays cross: near their tips only the rays are lit, so the light's mean row
        # in the outer quarter each side is the horizontal ray's, and likewise the columns.
        qx, qy = (x1 - x0) // 4, (y1 - y0) // 4
        cy = (mean(lum[:, x0:x0 + qx], 1) + mean(lum[:, x1 - qx:x1], 1)) / 2
        cx = (mean(lum[y0:y0 + qy], 0) + mean(lum[y1 - qy:y1], 0)) / 2
        reach = max(cx - x0, x1 - cx, cy - y0, y1 - cy)
        a = shift(a, cx, cy, S / 2 * TIP / reach)
        save(unblack(a).resize((256, 256), Image.LANCZOS), f"decision-{col}-{i:02d}")
        if col == "white":
            save_grey(a, f"decision-mono-{i:02d}", fade=(0.97, 1.0))

# Nurseries from the atlas pack, in greyscale for the status palettes.
for i in range(1, 4):
    save_grey(rgb(f"pack/stellar_nurseries/nursery_{i:02d}.png"), f"nursery-{i:02d}", fade=(0.74, 0.96))


# The lowest-energy path across `e` from left to right, one row up or down at most per column.
def seam(e):
    h, w = e.shape
    c, back = e.copy(), np.zeros((h, w), int)
    for x in range(1, w):
        p = np.stack([np.r_[np.inf, c[:-1, x - 1]], c[:, x - 1], np.r_[c[1:, x - 1], np.inf]])
        k = p.argmin(0)
        back[:, x] = k - 1
        c[:, x] += p[k, np.arange(h)]
    y = [int(c[:, -1].argmin())]
    for x in range(w - 1, 0, -1):
        y.append(y[-1] + back[y[-1], x])
    return np.array(y[::-1])


# Protostars: a sheet of six, three by two. Their jets and dust reach past the grid's lines (the
# tiles cut from it are clipped there), so each column's two are parted along the darkest path
# between them instead. The blue one's jet runs off the sheet's top, so the top edge is faded.
# Each is centred on its core (the peak of the blurred brightness) and all share one scale, the
# widest reach plus a margin. Written in their own paint, and greyscale ("protostar-mono") for
# the settled ones, coloured by palette.
sheet = rgb("protostars/source_sheet.png")
sheet = sheet * smoothstep(0, 40, np.arange(sheet.shape[0], dtype=np.float32))[:, None, None]
lum = sheet.max(axis=2)
soft = np.asarray(Image.fromarray((lum * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(24))).astype(np.float32) / 255
bodies = []
for col in range(3):
    band = lum[:, col * 512:(col + 1) * 512]
    e = np.asarray(Image.fromarray((band[300:720] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))).astype(np.float32)
    below = np.arange(lum.shape[0])[:, None] >= (seam(e) + 300)[None, :]
    for row, mask in enumerate((~below, below)):
        full = np.zeros(lum.shape, bool)
        full[:, col * 512:(col + 1) * 512] = mask
        cy, cx = np.unravel_index(np.where(full, soft, 0).argmax(), lum.shape)
        ys, xs = np.nonzero(full & (lum > 0.03))
        reach = max(cx - xs.min(), xs.max() - cx, cy - ys.min(), ys.max() - cy)
        bodies.append((row * 3 + col + 1, sheet * full[..., None], cx, cy, reach))
reach = max(b[4] for b in bodies) * 1.04
for i, a, cx, cy, _ in sorted(bodies, key=lambda b: b[0]):
    im = Image.fromarray((a * 255).astype(np.uint8))
    a = np.asarray(im.transform((S, S), Image.EXTENT, (cx - reach, cy - reach, cx + reach, cy + reach), Image.BICUBIC, fillcolor=(0, 0, 0))).astype(np.float32) / 255
    save(unblack(a), f"protostar-{i:02d}")
    save_grey(a, f"protostar-mono-{i:02d}", fade=(0.9, 1.0))

# Rocks: the asteroid belt's own stones, cut out one by one (connected patches of a fair size
# that aren't a run of several), each in a 64 px tile.
belt = rgb("pack/dust_and_rings/orbital_dust_01.png")
m = belt.max(axis=2) > 0.27
seen = np.zeros_like(m)
rocks = []
for y0 in range(S):
    for x0 in range(S):
        if not m[y0, x0] or seen[y0, x0]:
            continue
        st, pts = [(y0, x0)], []
        seen[y0, x0] = True
        while st:
            y, x = st.pop()
            pts.append((y, x))
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < S and 0 <= nx < S and m[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    st.append((ny, nx))
        ys, xs = zip(*pts)
        w, h = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        if 300 <= len(pts) <= 1400 and 0.65 <= w / h <= 1.5 and len(pts) / (w * h) > 0.4:
            rocks.append((len(pts), min(xs), min(ys), max(xs), max(ys), pts))
rocks.sort(key=lambda r: -r[0])
for i, (_, x0, y0, x1, y1, pts) in enumerate(rocks[:8]):
    mask = np.zeros((S, S), np.float32)
    for y, x in pts:
        mask[y, x] = 1
    # A stone's shaded side is dark, so its patch misses it: the tile's alpha is the patch or
    # an ellipse filling its box, whichever is more, so the whole stone comes along.
    m2 = 3
    crop = belt[y0 - m2:y1 + m2 + 1, x0 - m2:x1 + m2 + 1]
    mk = mask[y0 - m2:y1 + m2 + 1, x0 - m2:x1 + m2 + 1]
    yy, xx = np.mgrid[0:crop.shape[0], 0:crop.shape[1]].astype(np.float32)
    ell = np.hypot((xx - crop.shape[1] / 2 + 0.5) / (crop.shape[1] / 2 - m2), (yy - crop.shape[0] / 2 + 0.5) / (crop.shape[0] / 2 - m2))
    img = unblack(crop, np.clip(np.maximum(mk, 1 - smoothstep(0.85, 1.0, ell)), 0, 1))
    side = max(img.size)
    tile = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    tile.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    save(tile.resize((64, 64), Image.LANCZOS), f"rock-{i + 1:02d}", q=92)
print("ok")
