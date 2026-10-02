import json, sys, collections
import pymupdf

src, out = sys.argv[1], sys.argv[2]  # brochure PDF, docs folder
MAX_LOT = 2400
doc = pymupdf.open(src)
page = doc[0]

def center(chars):
    xs = [c['bbox'][0] for c in chars] + [c['bbox'][2] for c in chars]
    ys = [c['bbox'][1] for c in chars] + [c['bbox'][3] for c in chars]
    return [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2]

def split_glued(chars):
    """Split a run of touching lot labels into equal-width consecutive numbers."""
    text = ''.join(c['c'] for c in chars)
    for w in (4, 3, 2, 1):
        if len(text) % w:
            continue
        parts = [chars[i:i + w] for i in range(0, len(chars), w)]
        nums = [int(''.join(c['c'] for c in p)) for p in parts]
        if all(0 < n <= MAX_LOT for n in nums) and all(abs(a - b) <= 3 for a, b in zip(nums, nums[1:])):
            return list(zip(nums, parts))
    return None

found = collections.defaultdict(list)
unsplit = []
for block in page.get_text('rawdict')['blocks']:
    for line in block.get('lines', []):
        for span in line['spans']:
            chars = [c for c in span['chars'] if not c['c'].isspace()]
            text = ''.join(c['c'] for c in chars)
            if not text.isdigit():
                continue
            if len(text) <= 4 and int(text) <= MAX_LOT:
                found[int(text)].append(center(chars))
            elif len(text) > 4:
                parts = split_glued(chars)
                if parts:
                    for n, p in parts:
                        found[n].append(center(p))
                else:
                    unsplit.append(text)

def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5

lots = {}
for n, pts in found.items():
    if n < 1:
        continue
    if len(pts) == 1:
        lots[n] = pts[0]
# ambiguous labels: keep the candidate closest to a numeric neighbour
for n, pts in found.items():
    if len(pts) > 1 and n >= 1:
        near = [lots[m] for m in (n - 1, n + 1) if m in lots]
        lots[n] = min(pts, key=lambda p: min([dist(p, q) for q in near] or [0]))

# labels that sit far from both numeric neighbours are stray fragments
stray = []
for n in sorted(lots):
    a, b = lots.get(n - 1), lots.get(n + 1)
    if a and b and dist(a, b) < 25 and dist(lots[n], a) > 60 and dist(lots[n], b) > 60:
        stray.append(n)
for n in stray:
    del lots[n]

# fill unreadable labels from the nearest known lot numbers on each side
filled = []
for n in range(1, MAX_LOT + 1):
    if n in lots:
        continue
    lo = next((m for m in range(n - 1, 0, -1) if m in lots and m not in filled), None)
    hi = next((m for m in range(n + 1, MAX_LOT + 1) if m in lots and m not in filled), None)
    if lo and hi:
        t = (n - lo) / (hi - lo)
        lots[n] = [lots[lo][0] + (lots[hi][0] - lots[lo][0]) * t, lots[lo][1] + (lots[hi][1] - lots[lo][1]) * t]
    else:
        lots[n] = list(lots[lo or hi])
    filled.append(n)

print('read', MAX_LOT - len(filled), 'estimated', len(filled), 'stray', stray)
print('estimated lots', filled)
print('unsplit', unsplit)

xs = [v[0] for v in lots.values()]; ys = [v[1] for v in lots.values()]
m = 14
clip = pymupdf.Rect(min(xs) - m, min(ys) - m, max(xs) + m, max(ys) + m)
scale = 5
pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False)
pix.save(out + r'\map.jpg', jpg_quality=72)
print('image', pix.width, pix.height)

data = {
    'community': 'Verdana Village',
    'image': {'w': pix.width, 'h': pix.height},
    # lot number -> [x, y] in map image pixels
    'lots': {str(n): [round((lots[n][0] - clip.x0) * scale), round((lots[n][1] - clip.y0) * scale)] for n in sorted(lots)},
    # lots whose label could not be read; position is estimated from neighbours
    'estimated': filled,
}
with open(out + r'\lots.json', 'w') as f:
    json.dump(data, f, separators=(',', ':'))

