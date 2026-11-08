# Workshop illustration cutout

- Mode: built-in `image_gen` image edit, `background-extraction`.
- Input inspected with `view_image`: `design-assets/nabda-workshop-original.png`.
- Tool settings: `transparent_background: true`; `referenced_image_paths` contained only that input PNG.
- Generated PNG: `/Users/mohamedbay/.codex/generated_images/01a1bc5a-eb89-7cc1-a28c-6cfe794d3b59/exec-fa23d83a-c1b0-474f-8168-f46d2792f1a8.png`.
- Saved project PNG: `design-assets/nabda-workshop-cutout.png`.
- Website asset: `public/illustrations/nabda-workshop-cutout.webp`.
- Conversion: Sharp `webp({lossless:true})`, format conversion only; no resizing, cropping, masking, color replacement or alpha editing.

## Exact prompt

```text
Use case: background-extraction.
Asset type: transparent cutout of an existing hand-drawn website hero illustration.
Input image: the attached local PNG is the EDIT TARGET, not inspiration. Preserve its original composition exactly.
Primary request: Remove ONLY the external warm white/beige paper background and make that background genuinely transparent alpha, including all negative spaces between separate objects and inside open cable curves. Preserve the EXACT existing ink contours, irregular hand-drawn hatching, laptop with braces, small cloud, cable and peach tag, tall mint phone with peach SIM card, stack of white envelopes, floating peach-and-white envelope with dotted arrow, and human hand with mint sleeve. Keep the exact subject positions, proportions, palette, line weights and tiny details. Keep white fills inside the laptop screen, phone screen, envelope bodies, cloud, hand and other enclosed illustrated surfaces OPAQUE WHITE. Keep the fine baseline ink hatching. No repainting, no restyling, no new objects or text, no removal of drawn details, no cropping or reframing. Output the same full wide composition with only the external paper backdrop converted to real transparent alpha. Do not render a checkerboard or colored background.
```

## Verification

Both files are 1774 × 887 with an alpha channel. Each contains 1,069,606 pixels at alpha 0. All four corners and sampled external gaps `(1153,133)` and `(443,177)` have RGBA `(0,0,0,0)`.

The generator retained near-opaque white interior fills rather than cutting them out: sampled phone/laptop/cloud interiors have alpha 254; envelope/hand samples have alpha 253. These are the original generated alpha values, preserved losslessly. No programmatic image editing was applied to force interior alpha to 255.

Visual inspection confirms the laptop, cloud, mint phone, SIM, envelopes, dotted route, human hand, and baseline hatching remain present, with the surrounding paper removed.
