// The painted bodies: textures in public/bodies, cut by scripts/import-pack.py. Most keep their
// own paint and transparency, drawn as they are: the research nebulae, the protostars, the green
// and white decision stars, the sun, the coronas, the stars, the rocks and the coloured planets.
// The rest are greyscale, light on black, coloured on first use by a palette (brightness picks
// the colour and sets the alpha, so the black falls away): the nurseries, "fog" (the nebulae
// again, for the clouds coloured by palette), "protostar-mono" (the protostars again, for the
// settled ones), "decision-mono" (the white decision stars again, for the other statuses), and
// the planets' mono set, tinted keeping its disc. Each keeps three sizes, so a small body is
// drawn from a small image and doesn't shimmer. Until an image has loaded, `texture` returns
// null and the engine draws its own stand-in.

export type Kind = "nebula" | "fog" | "protostar" | "nursery" | "corona" | "sun" | "star" | "rock" | "protostar-mono" | "decision-green" | "decision-white" | "decision-mono" | "planet-green" | "planet-yellow" | "planet-red" | "planet-gray" | "planet-blue" | "planet-mono";
// How many of each. The coronas and stars come in six colours: orange, blue, magenta, ringed
// orange, red and violet; the protostars in orange, blue, magenta, red, green and violet.
const SET: Record<Kind, number> = {
  nebula: 8, fog: 8, protostar: 6, "protostar-mono": 6, "decision-green": 3, "decision-white": 3, "decision-mono": 3, nursery: 3, corona: 6, sun: 1, star: 6, rock: 8,
  "planet-green": 3, "planet-yellow": 3, "planet-red": 3, "planet-gray": 3, "planet-blue": 3, "planet-mono": 3,
};
// The smaller sizes kept, as fractions of the image's own.
const STEPS = [1, 0.375, 0.125];

// A palette: the colours for dark, mid, bright and brightest, and how strongly it shows; with
// `disc`, the image keeps its own transparency (a tinted planet). No palette draws it as it is.
export type Palette = { stops: [string, string, string, string]; gain: number; disc?: boolean };

const images = new Map<string, HTMLImageElement>();
const tinted = new Map<string, HTMLCanvasElement[]>();
let started = false;
let budget = Infinity;

// How many new colourings the coming frame may make. Each reads and writes every pixel of its
// image, so a map's first frame would stall on dozens of them; spread out, they arrive a few a
// frame while the map fades in.
export function textureBudget(n: number) {
  budget = n;
}

function load() {
  if (started || typeof window === "undefined") return;
  started = true;
  for (const kind of Object.keys(SET) as Kind[]) {
    for (let i = 1; i <= SET[kind]; i++) {
      const name = `${kind}-${String(i).padStart(2, "0")}`, img = new Image();
      img.onload = () => images.set(name, img);
      img.src = `/bodies/${name}.webp`;
    }
  }
}

const rgb = (hex: string) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

// Brightness 0–255 to colour, blending between the palette's stops.
function lut(p: Palette) {
  const at = [0, 0.4, 0.75, 1], cs = p.stops.map(rgb), out = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    let k = 0;
    while (k < 2 && t > at[k + 1]) k++;
    const f = (t - at[k]) / (at[k + 1] - at[k]);
    for (let c = 0; c < 3; c++) out[v * 3 + c] = cs[k][c] + (cs[k + 1][c] - cs[k][c]) * f;
  }
  return out;
}

function colour(img: HTMLImageElement, p: Palette | null) {
  const S = img.naturalWidth, big = document.createElement("canvas");
  big.width = big.height = S;
  const ctx = big.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, S, S);
  if (p) {
    const d = ctx.getImageData(0, 0, S, S), px = d.data, map = lut(p);
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i];
      px[i] = map[v * 3]; px[i + 1] = map[v * 3 + 1]; px[i + 2] = map[v * 3 + 2];
      if (!p.disc) px[i + 3] = Math.min(255, v * p.gain);
    }
    ctx.putImageData(d, 0, 0);
  }
  const mips = [big];
  for (const s of STEPS.slice(1).map((k) => Math.round(S * k))) {
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const cx = c.getContext("2d")!;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(mips[mips.length - 1], 0, 0, s, s);
    mips.push(c);
  }
  return mips;
}

// Texture `seed` of a kind (its index, wrapped) in a palette, at the size nearest above `px`
// (its diameter on screen, in device pixels); null until its image has loaded.
export function texture(kind: Kind, seed: number, p: Palette | null, px: number) {
  load();
  const name = `${kind}-${String((Math.abs(seed) % SET[kind]) + 1).padStart(2, "0")}`;
  const key = p ? `${name}:${p.stops.join()}:${p.gain}` : name;
  let mips = tinted.get(key);
  if (!mips) {
    const img = images.get(name);
    if (!img || budget <= 0) return null;
    budget--;
    mips = colour(img, p);
    tinted.set(key, mips);
  }
  let i = mips.length - 1;
  while (i > 0 && mips[i].width < px) i--;
  return mips[i];
}
