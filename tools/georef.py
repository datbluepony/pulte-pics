"""Pin the master map to real GPS coordinates. Run after extract.py: py tools/georef.py docs

Matches the road grid from the brochure map against the real street network
(tools/osm-roads.json, from OpenStreetMap, ODbL), then writes the map's ground
position into lots.json and fills gaps in roads.png with the real streets.
"""
import json, math, os, sys
import numpy as np, cv2

P = sys.argv[1]  # docs folder
osm = json.load(open(os.path.join(os.path.dirname(__file__), 'osm-roads.json')))['elements']
LAT0, LON0, LAT1, LON1 = 26.452, -81.662, 26.424, -81.620   # top-left, bottom-right of the search area
MPP = 2.0  # metres per pixel of the street drawing
KY = 111320.0; KX = 111320.0 * math.cos(math.radians(26.44))
W = int((LON1 - LON0) * KX / MPP); H = int((LAT0 - LAT1) * KY / MPP)
def xy(p): return [(p['lon'] - LON0) * KX / MPP, (LAT0 - p['lat']) * KY / MPP]

img = np.zeros((H, W), np.uint8)
for e in osm:
    if e['tags']['highway'] in ('residential', 'secondary', 'primary', 'tertiary', 'unclassified'):
        cv2.polylines(img, [np.array([xy(p) for p in e['geometry']], np.int32)], False, 255, 5)

roads = cv2.imread(P + '/roads.png', 0)
tmpl = ((roads == 255) * 255).astype(np.uint8)
tmpl[:40, :] = 0   # drop the Corkscrew Road band and the amenity car park at the top
best = None
for k in np.arange(1.2, 2.8, 0.01):
    t = cv2.resize(tmpl, None, fx=k, fy=k, interpolation=cv2.INTER_LINEAR)
    if t.shape[0] > H or t.shape[1] > W: continue
    _, v, _, loc = cv2.minMaxLoc(cv2.matchTemplate(img, t, cv2.TM_CCORR_NORMED))
    if not best or v > best[0]: best = (v, k, loc)
v, k, loc = best
print('match score', round(v, 3), 'scale', round(k, 3))

# fill the gaps in the road grid with the real streets
gh, gw = roads.shape
real = cv2.resize(img[loc[1]:loc[1] + int(round(gh * k)), loc[0]:loc[0] + int(round(gw * k))], (gw, gh), interpolation=cv2.INTER_AREA)
roads[real > 40] = 255
cv2.imwrite(P + '/roads.png', roads)

# where the master map sits on the ground: lat/lon of map pixel (0, 0) and degrees per map pixel
data = json.load(open(P + '/lots.json'))
m_per_px = k * MPP / data['grid']['cell']
data['geo'] = {
    'lat0': LAT0 - loc[1] * MPP / KY, 'lon0': LON0 + loc[0] * MPP / KX,
    'dLat': -m_per_px / KY, 'dLon': m_per_px / KX, 'mPerPx': m_per_px,
}
json.dump(data, open(P + '/lots.json', 'w'), separators=(',', ':'))
print(data['geo'])
