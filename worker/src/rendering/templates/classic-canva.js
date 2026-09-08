const freeze = (value) => Object.freeze(value);

// Initial calibration only. Every adjustable layout value lives here so later
// visual-fixture tuning never needs changes inside the renderer or API handler.
export const CONTENT_DEFAULT_FONT_SIZE = 70;
export const CONTENT_MIN_FONT_SIZE = 40;
export const CONTENT_FONT_STEP = 2;
export const CONTENT_MAX_WIDTH = 650;
export const CONTENT_MAX_HEIGHT = 520;
export const RENDER_MAX_GRAPHEMES = 140;

export function formatClassicPostNumber(id) {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError("Post id must be a positive safe integer.");
  }

  return `#${String(id).padStart(3, "0")}`;
}

export const classicCanvaTemplate = freeze({
  id: "classic-canva",
  rendererVersion: "classic-canva-v1",
  width: 1080,
  height: 1350,
  background: freeze({
    assetPath: "assets/DAAN-anonymous.png"
  }),
  postNumber: freeze({
    centerX: 403,
    centerY: 319,
    fontFamily: "Anton",
    fontStyle: "Regular",
    fontSize: 64,
    color: "#111111",
    font: freeze({
      assetPath: "assets/fonts/Anton-Regular.ttf",
      allowSyntheticBold: false,
      allowFallback: false
    })
  }),
  content: freeze({
    centerX: 540,
    centerY: 690,
    maxWidth: CONTENT_MAX_WIDTH,
    maxHeight: CONTENT_MAX_HEIGHT,
    defaultFontSize: CONTENT_DEFAULT_FONT_SIZE,
    minFontSize: CONTENT_MIN_FONT_SIZE,
    fontStep: CONTENT_FONT_STEP,
    lineHeight: 1.3,
    fontFamily: "可畫錦繡體-繁",
    align: "center",
    color: "#111111",
    maxGraphemes: RENDER_MAX_GRAPHEMES,
    font: freeze({
      assetPath: "assets/fonts/KeHuaJinXiuTi-Traditional.ttf",
      allowFallback: false
    }),
    lineCountYOffset: freeze({
      1: 8,
      2: 5,
      3: 2,
      4: 0,
      5: -3,
      6: -5,
      7: -7,
      8: -9,
      default: -10
    })
  })
});
