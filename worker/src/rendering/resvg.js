export function createResvgRasterizer(Resvg) {
  return async function rasterize({ svg }) {
    const instance = new Resvg(svg, {
      fitTo: { mode: "original" },
      imageRendering: 0,
      shapeRendering: 2,
      textRendering: 2
    });
    let rendered;
    try {
      rendered = instance.render();
      return rendered.asPng().slice();
    } finally {
      rendered?.free();
      instance.free();
    }
  };
}
