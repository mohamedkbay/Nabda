"""Inspect the exact WebP assets served to browsers; never modifies images."""
import json
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
paths = sorted((root / 'public' / 'illustrations').glob('*-cutout.webp'))
assert len(paths) == 4, f'Expected four served cutouts, found {len(paths)}'
results = []
for path in paths:
    with Image.open(path) as source:
        assert source.mode == 'RGBA', f'{path.name}: no alpha channel ({source.mode})'
        width, height = source.size
        alpha = source.getchannel('A')
        histogram = alpha.histogram()
        corners = [alpha.getpixel(point) for point in [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]]
        minimum, maximum = alpha.getextrema()
        transparent_fraction = histogram[0] / (width * height)
        # Soft generated alpha can retain 1/255 opacity at exterior pixels.
        # Record the exact values; this threshold does not excuse a backdrop.
        assert max(corners) <= 1, f'{path.name}: visible exterior corner alpha {corners}'
        assert minimum == 0 and maximum > 0 and transparent_fraction > .05
        results.append({'file': str(path.relative_to(root)), 'mode': source.mode, 'size': [width, height], 'alpha_extrema': [minimum, maximum], 'corner_alpha': corners, 'fully_transparent_fraction': round(transparent_fraction, 4)})
output = root / 'outputs' / 'qa' / 'cutouts'
output.mkdir(parents=True, exist_ok=True)
(output / 'alpha-results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
