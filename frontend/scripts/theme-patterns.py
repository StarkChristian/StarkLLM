"""SVG background tiles for the pattern themes (index.css, --bg-pattern), written as CSS data URIs.

Run: python3 frontend/scripts/theme-patterns.py patterns.json, then copy each url(...) into its [data-theme] block.
The tiles are drawn here, so nothing is loaded from the internet. "#" must be encoded in a data URI.
"""
import random
import urllib.parse

def doll(c):  # a small doll: head with two pigtails, dress, arms, legs
    return (f'<g fill="none" stroke="{c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
            '<circle cx="0" cy="-9" r="5"/><circle cx="-6.5" cy="-11" r="2"/><circle cx="6.5" cy="-11" r="2"/>'
            '<path d="M-2,-9.5h0M2,-9.5h0M-1.6,-7 q1.6,1.4 3.2,0"/>'
            '<path d="M0,-4 L-7,9 H7 Z"/><path d="M-3,-1 L-9,3M3,-1 L9,3M-3,9 v5M3,9 v5"/></g>')
def heart(c):
    return f'<path d="M0,6 C-9,-1 -6,-9 0,-4 C6,-9 9,-1 0,6Z" fill="none" stroke="{c}" stroke-width="1.6" stroke-linejoin="round"/>'
def star(c):
    return f'<path d="M0,-8 L2.4,-2.5 8,-2.5 3.5,1.2 5.2,7 0,3.6 -5.2,7 -3.5,1.2 -8,-2.5 -2.4,-2.5Z" fill="none" stroke="{c}" stroke-width="1.5" stroke-linejoin="round"/>'
def envelope(c):
    return f'<g fill="none" stroke="{c}" stroke-width="1.6" stroke-linejoin="round"><rect x="-9" y="-6" width="18" height="12" rx="2"/><path d="M-9,-5 L0,1 L9,-5"/></g>'
def flower_line(c):
    return (f'<g fill="none" stroke="{c}" stroke-width="1.5">' + "".join(
        f'<ellipse cx="0" cy="-5" rx="2.6" ry="4.2" transform="rotate({a})"/>' for a in range(0, 360, 72)) +
        '<circle r="1.8"/></g>')
def moon(c):
    return f'<path d="M3,-8 A8,8 0 1,0 3,8 A6,6 0 1,1 3,-8Z" fill="none" stroke="{c}" stroke-width="1.6" stroke-linejoin="round"/>'
def cloud(c):
    return f'<path d="M-9,4 a4,4 0 0,1 1,-8 a6,6 0 0,1 11,-1 a4.5,4.5 0 0,1 6,9Z" fill="none" stroke="{c}" stroke-width="1.6" stroke-linejoin="round"/>'
def bubble(c):
    return f'<path d="M-9,-6 h18 a2,2 0 0 1 2,2 v8 a2,2 0 0 1 -2,2 h-10 l-5,4 v-4 h-3 a2,2 0 0 1 -2,-2 v-8 a2,2 0 0 1 2,-2Z" fill="none" stroke="{c}" stroke-width="1.5" stroke-linejoin="round"/>'
def plane(c):
    return f'<path d="M-9,1 L9,-7 L3,8 L0,2 Z M0,2 L9,-7" fill="none" stroke="{c}" stroke-width="1.5" stroke-linejoin="round"/>'
def teddy(c):
    return (f'<g fill="none" stroke="{c}" stroke-width="1.5"><circle cx="0" cy="-4" r="5"/><circle cx="-4.5" cy="-8.5" r="2"/>'
            '<circle cx="4.5" cy="-8.5" r="2"/><ellipse cx="0" cy="6" rx="6" ry="5"/><path d="M-1.5,-4.5h0M1.5,-4.5h0"/></g>')

def tile(size, items, bg=None):
    body = "".join(items)
    rect = f'<rect width="{size}" height="{size}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">{rect}{body}</svg>'

def place(shapes, color, size, n, seed, scale=(0.9, 1.25)):
    rnd = random.Random(seed)
    out, spots = [], []
    while len(out) < n:
        x, y = rnd.uniform(14, size - 14), rnd.uniform(14, size - 14)
        if any((x - a) ** 2 + (y - b) ** 2 < 34 ** 2 for a, b in spots):
            continue
        spots.append((x, y))
        f = shapes[len(out) % len(shapes)]
        out.append(f'<g transform="translate({x:.1f} {y:.1f}) rotate({rnd.uniform(-35, 35):.0f}) scale({rnd.uniform(*scale):.2f})">{f(color)}</g>')
    return out

def doodles(color, seed):
    return tile(300, place([doll, heart, star, envelope, flower_line, moon, cloud, bubble, plane, teddy, doll, heart], color, 300, 26, seed))

def flowers(seed):
    rnd = random.Random(seed)
    out, spots = [], []
    petals = ["#f9a8d4", "#fbcfe8", "#c4b5fd", "#fda4af", "#fdba74"]
    while len(out) < 22:
        x, y = rnd.uniform(10, 230), rnd.uniform(10, 230)
        if any((x - a) ** 2 + (y - b) ** 2 < 30 ** 2 for a, b in spots):
            continue
        spots.append((x, y))
        p = rnd.choice(petals); s = rnd.uniform(0.7, 1.15); r = rnd.uniform(0, 72)
        leaf = (f'<path d="M0,6 q6,4 10,12 q-8,-1 -10,-12Z" fill="#86efac" opacity="0.7"/>' if rnd.random() < 0.6 else "")
        flower = "".join(f'<ellipse cx="0" cy="-5.5" rx="3.2" ry="5" fill="{p}" transform="rotate({a})"/>' for a in range(0, 360, 72))
        out.append(f'<g transform="translate({x:.1f} {y:.1f}) rotate({r:.0f}) scale({s:.2f})" opacity="0.75">{leaf}{flower}'
                   f'<circle r="2.4" fill="#fcd34d"/></g>')
    for _ in range(26):  # tiny dots between the flowers
        out.append(f'<circle cx="{rnd.uniform(0,240):.0f}" cy="{rnd.uniform(0,240):.0f}" r="1.1" fill="#f9a8d4" opacity="0.5"/>')
    return tile(240, out)

def matrix(seed):
    rnd = random.Random(seed)
    glyphs = "01アカサタナハマヤラワ01ｱｲｳｴｵ2345789ZΞ"
    out = []
    for col in range(16):
        x = 8 + col * 15
        start = rnd.uniform(-200, 180)
        length = rnd.randint(6, 16)
        for i in range(length):
            y = start + i * 16
            if not (0 < y < 320):
                continue
            head = i == length - 1
            op = 0.9 if head else 0.12 + 0.55 * (i / length)
            fill = "#c8ffd8" if head else "#22c55e"
            ch = rnd.choice(glyphs).replace("<", "")
            out.append(f'<text x="{x}" y="{y:.0f}" font-family="monospace" font-size="13" fill="{fill}" opacity="{op:.2f}">{ch}</text>')
    return tile(240, out)

def stars(seed):
    rnd = random.Random(seed)
    out = []
    for _ in range(60):
        out.append(f'<circle cx="{rnd.uniform(0,260):.1f}" cy="{rnd.uniform(0,260):.1f}" r="{rnd.choice([0.6,0.8,1,1.3]):.1f}" fill="#ffffff" opacity="{rnd.uniform(0.25,0.9):.2f}"/>')
    for _ in range(4):
        x, y = rnd.uniform(20, 240), rnd.uniform(20, 240)
        out.append(f'<path transform="translate({x:.0f} {y:.0f})" d="M0,-5 L1,-1 5,0 1,1 0,5 -1,1 -5,0 -1,-1Z" fill="#fde68a" opacity="0.8"/>')
    return tile(260, out)

def uri(svg):
    return 'url("data:image/svg+xml,' + urllib.parse.quote(svg, safe=" =:/,;'()-.") + '")'

if __name__ == "__main__":
    import sys
    out = {
        "doodle": uri(doodles("rgba(120,96,70,0.22)", 3)),
        "doodle-night": uri(doodles("rgba(170,190,200,0.10)", 5)),
        "flowers": uri(flowers(7)),
        "matrix": uri(matrix(11)),
        "stars": uri(stars(13)),
    }
    for k, v in out.items():
        print(k, len(v))
    import json; json.dump(out, open(sys.argv[1], "w"))
    for k in out:  # previews
        svg = {"doodle": doodles("rgba(120,96,70,0.22)", 3), "doodle-night": doodles("rgba(170,190,200,0.10)", 5),
               "flowers": flowers(7), "matrix": matrix(11), "stars": stars(13)}[k]
        open(sys.argv[1].replace(".json", f"-{k}.svg"), "w").write(svg)
