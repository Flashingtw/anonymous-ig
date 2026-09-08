# Renderer font assets

The `classic-canva` renderer intentionally has no production font fallback.

Add legally licensed renderer files at the paths configured in
`worker/src/rendering/templates/classic-canva.js`:

- `assets/fonts/Anton-Regular.ttf`
- `assets/fonts/KeHuaJinXiuTi-Traditional.ttf`

`Anton-Regular.ttf` must be the real Anton Regular face. Do not substitute a
synthetic bold face. `KeHuaJinXiuTi-Traditional.ttf` must be the licensed
「可畫錦繡體-繁」font file supplied for this project.

If a supplied file uses another filename or OpenType container (`.otf`,
`.woff`, or `.woff2`), update only the matching `assetPath` in the template
configuration. Do not add a fallback family to the production template.
