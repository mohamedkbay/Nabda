# Story illustrations

Mode: built-in `image_gen.imagegen`, new image generation (`illustration-story`), opaque warm paper background. No CLI or paid API fallback was used.

## Message parts and outcomes

- Original: `design-assets/nabda-message-parts-original.png`
- Website asset: `public/illustrations/nabda-message-parts.webp`
- Generated with the built-in image tool; native1536×1024 pixels preserved, encoded as WebP at quality85/effort6.

Exact prompt:

```text
Use case: illustration-story. Asset type: the third companion scene for a long hand-drawn educational website about Nabda, an Android-phone SMS API. Create a landscape 3:2 editorial ink illustration on flat warm white paper #faf9f4. A clear clever scene about one long text becoming several SMS parts and the uncertainty of delivery: one large handwritten-looking letter sheet with simple horizontal lines, no readable words, is being carefully folded and divided into three small paper envelopes by two human hands. Three small delivery slips sit beside them, one with a handdrawn check mark, one with a simple waiting clock, one with a question mark. At far left a small chunky mint-green Android phone is connected by a loose dotted ink line to the paper. Give this scene a pleasing balanced arrangement of large objects and generous space, all objects completely within frame, no borders or panels. The medium is sophisticated confident brush-pen cartoon editorial drawing, charming imperfect contours with variable stroke weight and selective hand-hatched shadows. Charcoal #202824 contours, pale mint #c8edcb and muted peach #f0c9ad accents only. This must match a hand-drawn landscape of a mint Android phone with a SIM on its screen, laptop and envelopes, not generic flat vector software art. No faces or eyes on objects, no 3D, no gradients, no shine, no stock SaaS illustration, no sparkles, no logos, no watermark. No text, letters, numbers or labels except the single question mark and check mark on delivery slips. Do not draw a web interface or screenshot. Crisp print-quality art.
```

The existing `public/illustrations/nabda-workshop.webp` was visually inspected as a style reference; it was not edited or submitted as an edit target. Generated pixels were preserved. Sharp was used only for WebP encoding at quality 84, effort 6, without resizing or compositing.

## Pairing

- Original: `design-assets/nabda-pairing-original.png`
- Website asset: `public/illustrations/nabda-pairing.webp`
- The square pattern is decorative and does not pair any real device.

Exact prompt:

```text
Use case: illustration-story.
Asset type: final companion illustration for the Nabda website, landscape 1696 by 1104 pixels.
Primary request: An ink cartoon drawing of pairing an Android phone with a laptop. One coherent scene: a modest open laptop on a desk, its display showing one large abstract square pairing pattern made of a few irregular black modules (decorative, never a scannable QR code); a single natural human hand holds a chunky rounded mint-green Android phone in front of that display, scanning the pattern. The phone has a camera view of the square with simple corner brackets, no interface labels. A small physical metal key with a peach tag lies on the desk, separate from the laptop. All objects have clear correct perspective and plausible proportions. Leave generous calm negative space around the scene.
Style: sophisticated independent editorial illustrator, confident slightly uneven variable-width black ink outlines, lively pen strokes, sparse diagonal hand hatching for cast shadows and dimensional edges. The chunky mint phone has a rounded bezel, small top speaker and bottom oval home button. Warm white paper #faf9f4, ink #202824, restrained mint #c8edcb and peach #f0c9ad color washes only. Hand-drawn 2D pen-on-paper cartoon, warm practical human mood, carefully composed, crisp and readable at website scale.
Composition: centered scene occupying about 75% of a wide canvas, eye-level three-quarter view, desk suggested by one short ink baseline with hatched shadows; quiet white edges with nothing cropped, no surrounding room or extra decorations.
Text: none. Absolutely no lettering, words, numbers, labels, logos, watermarks, branded Android emblem, or functional QR code.
Avoid: flat SaaS vector graphics, glossy 3D, photorealism, gradients, complex UI screenshots, robotic hands, extra fingers, extra objects, cartoon eyes or faces on devices.
```

## Phone-owned queue

- Original: `design-assets/nabda-phone-queue-original.png`
- Website asset: `public/illustrations/nabda-phone-queue.webp`

Exact prompt:

```text
Use case: illustration-story.
Asset type: final companion illustration for the Nabda website, landscape 1696 by 1104 pixels.
Primary request: A coherent ink cartoon explaining that the message queue lives safely inside an Android phone and can keep working offline. One large chunky mint-green Android phone stands on the desk, its front opened like a small filing cabinet. Inside its body are three neat durable shallow drawers; the upper drawer is pulled out just enough to reveal a tidy line of paper envelopes standing in order, with more envelopes in the other drawers. The opened cabinet is clearly contained inside the phone, with a visible rounded mint bezel, little top speaker, and bottom oval home button. One white envelope with a peach flap has just left the phone to the right, with a short dotted ink flight trail. Behind and to the left sits one modest outlined cloud; its short cable ends in a clearly unplugged connector near the desk, visibly separated from the phone. The phone remains active and orderly. No faces, eyes, limbs, or anthropomorphic behavior on any device.
Style: sophisticated independent editorial illustrator, confident slightly uneven variable-width black ink outlines, lively pen strokes, sparse diagonal hand hatching for cast shadows and dimensional edges. Match a simple warm hand-drawn pen-on-paper cartoon of a chunky rounded mint Android phone and paper envelopes. Warm white paper #faf9f4, ink #202824, restrained mint #c8edcb and peach #f0c9ad color washes only. Crisp readable illustration with a practical, reassuring mood.
Composition: one central phone and drawer scene with believable three-quarter perspective, about 75% of a wide canvas, plenty of blank paper around it. The little disconnected cloud stays a secondary background element. A short ink baseline and diagonal hatching suggest a desk; no busy room.
Text: none. Absolutely no lettering, words, numbers, labels, interface writing, logos or watermarks.
Avoid: flat SaaS vector graphics, glossy 3D, photorealism, gradients, padlocks, shields, complex diagrams, duplicated phones, scattered chaotic envelopes, faces or eyes on devices.
```

## Transparent cutout edits

Mode: built-in `image_gen.imagegen` edit mode with `transparent_background: true`, one call per original PNG. Both originals were viewed before editing. Generated cutout pixels were preserved; Sharp was used only to encode WebP at quality 88, alphaQuality 100, effort 6, without resizing, recoloring, masking, or compositing. White/cream object interiors remain filled; only the outside paper was requested to become alpha.

### Pairing cutout

- Edit target: `design-assets/nabda-pairing-original.png`
- Edited PNG: `design-assets/nabda-pairing-cutout.png`
- Website asset: `public/illustrations/nabda-pairing-cutout.webp`

Exact prompt:

```text
Use case: background-extraction.
Input image: the attached Nabda pairing illustration is the sole edit target.
Perform only background removal. Make a genuine transparent PNG cutout of this exact existing hand-drawn illustration. Remove the outside warm beige/off-white paper background to full alpha transparency, including the negative-space gaps around the hand, phone, laptop, key, tag, and sparse desk hatch marks. There must be NO opaque paper rectangle or replacement background.
Preserve the exact original composition, canvas framing, ink contours, variable pen strokes, hand hatching, laptop perspective, decorative abstract pairing pattern, human hand anatomy and pose, mint-green phone bezel, peach key tag, and all drawn objects. Keep the white/cream fills INSIDE the laptop display, phone display, laptop body, key and cuff where they belong to the actual objects; these interior whites must remain opaque. Keep the delicate desk baseline and ink cast-shadow hatching as ink on transparency. Preserve the original mint/peach colors and illustration identity precisely. Do not redraw, repaint, restyle, move, crop, add, remove, or relabel any subject. Do not invent any letters or labels. Outside paper only becomes alpha; the actual illustration stays exactly as it is.
```

### Phone-owned queue cutout

- Edit target: `design-assets/nabda-phone-queue-original.png`
- Edited PNG: `design-assets/nabda-phone-queue-cutout.png`
- Website asset: `public/illustrations/nabda-phone-queue-cutout.webp`

Exact prompt:

```text
Use case: background-extraction.
Input image: the attached Nabda phone-owned queue illustration is the sole edit target.
Perform only background removal. Make a genuine transparent PNG cutout of this exact existing hand-drawn illustration. Remove the outside warm beige/off-white paper background to full alpha transparency, including all negative-space gaps around the disconnected cloud, cable, plug, phone-cabinet, opened door, paper envelope in flight, dotted ink trail, and sparse desk hatch marks. There must be NO opaque paper rectangle or replacement background.
Preserve the exact existing composition and framing, original variable black ink contours and hatching, proportions, mint-green phone-cabinet, three orderly drawers of envelopes, open right-hand door, unplugged cable on the left, floating outgoing envelope on the right, and dotted trail. Keep the white/cream fills INSIDE all paper envelopes, the outlined cloud, cable, phone details and other drawn objects fully opaque; these actual object interiors must NOT become transparent. Keep the subtle peach envelope flaps and mint washes precisely. Preserve desk baseline and cast-shadow hatch strokes as ink on transparency.
Do not redraw, repaint, restyle, move, crop, add, remove, relabel, or anthropomorphize any subject. No letters or new objects. Outside paper only becomes alpha; the actual illustration stays exactly as it is.
```
