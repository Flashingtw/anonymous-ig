import { createOpenTypeFont } from "./font.js";
import { layoutContent, layoutPostNumber } from "./layout.js";
import { readPngDimensions } from "./png.js";
import { composeClassicSvg } from "./svg.js";
import { classicCanvaTemplate } from "./templates/classic-canva.js";
import { RenderError } from "./errors.js";

export function createClassicCanvaRenderer({ assets, rasterize, template = classicCanvaTemplate }) {
  const dimensions = readPngDimensions(assets.background);
  if (dimensions.width !== template.width || dimensions.height !== template.height) {
    throw new RenderError(
      "RENDER_BACKGROUND_SIZE_MISMATCH",
      "classic Canva 底圖尺寸不正確。",
      { expected: [template.width, template.height], actual: [dimensions.width, dimensions.height] }
    );
  }

  const postNumberFont = createOpenTypeFont(assets.postNumberFont, {
    family: template.postNumber.fontFamily
  });
  const contentFont = createOpenTypeFont(assets.contentFont, {
    family: template.content.fontFamily
  });

  return Object.freeze({
    async render({ id, content }) {
      const postNumber = layoutPostNumber(id, postNumberFont, template.postNumber);
      const contentLayout = layoutContent(content, contentFont, template.content);
      const svg = composeClassicSvg(
        template,
        assets.background,
        postNumber,
        contentLayout
      );
      const bytes = await rasterize({ svg });
      return {
        bytes,
        contentType: "image/png",
        layout: { postNumber, content: contentLayout }
      };
    }
  });
}
