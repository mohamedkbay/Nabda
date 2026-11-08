# Message parts cutout

Built-in `image_gen.imagegen` edit with `transparent_background: true`. The existing original was viewed and passed as `referenced_image_paths`. Original scene and interior paper fills were preserved; the outside paper backdrop became genuine alpha. Sharp only encoded the result as WebP, quality86, alphaQuality100, effort6. No programmatic background removal, painting, crop, or compositing was used.

- Original: `design-assets/nabda-message-parts-original.png`
- Transparent master: `design-assets/nabda-message-parts-cutout.png`
- Website: `public/illustrations/nabda-message-parts-cutout.webp`

Exact edit prompt:

```text
Edit this existing illustration only by removing its outside background. Deliver the exact same scene as a clean transparent PNG cutout with real alpha: preserve the mint Android phone, peach SIM, long letter sheet with all horizontal ink lines, both human hands, three envelopes, three green result slips, clock, question/check marks, arrows, fine outlines and hatched shadows. Preserve composition, proportions, hand-drawn contours and charcoal/mint/peach palette. Do not redraw, simplify, add objects, crop, recolor or put anything in a frame. Remove the warm cream paper backdrop throughout ALL external negative space, including gaps between the phone, sheet, envelopes, arrows, and slips. Interior paper areas belonging to the long letter, white envelope faces, phone screen, and hands should stay opaque warm-white; only the external backdrop becomes transparent. No beige rectangular canvas, no grey or checkerboard baked into pixels, no border, no drop shadow around a rectangle. Preserve fine isolated pen hatching and small dotted strokes with smooth alpha edges. The output must sit directly over a patterned website background without a visible rectangular image boundary.
```
