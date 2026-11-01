"""Build the sample change order used by the app's "Try a sample" flow and the demo.

Rev C is NIST's public-domain PMI test drawing CTC-01 (rotation flattened). Rev D makes four edits:
  declared:   bore callout O25 +-0.15 becomes O25.5 +-0.15; a new edge-break note
  undeclared: one hole moves 3 mm; datum feature C is removed
usage: python make_sample.py <nist_ctc_01.pdf> <out_dir>
"""
import sys, os
import pymupdf

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
MM = 72 / 25.4


def load():
    d = pymupdf.open(SRC)
    p = d[0]
    if p.rotation:
        p.remove_rotation()
    return d, p


def paths_in(page, box, color=None):
    out = []
    for d in page.get_drawings():
        r = pymupdf.Rect(d['rect'])
        col = d.get('color') or d.get('fill')
        if r.is_empty or not box.contains(r):
            continue
        if color and (not col or max(abs(a - b) for a, b in zip(col, color)) > 0.15):
            continue
        out.append(d)
    return out


def remove(page, box):
    page.add_redact_annot(box, fill=False)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, text=pymupdf.PDF_REDACT_TEXT_NONE)


def redraw(page, paths, fn):
    sh = page.new_shape()
    for p in paths:
        for it in p['items']:
            pts = [fn(pymupdf.Point(x)) for x in it[1:] if isinstance(x, pymupdf.Point)]
            if it[0] == 'l':
                sh.draw_line(*pts)
            elif it[0] == 'c':
                sh.draw_bezier(*pts)
            elif it[0] == 're':
                r = it[1]; q = [fn(r.tl), fn(r.tr), fn(r.br), fn(r.bl)]; sh.draw_polyline(q + [q[0]])
            elif it[0] == 'qu':
                q = it[1]; qq = [fn(q.ul), fn(q.ur), fn(q.lr), fn(q.ll)]; sh.draw_polyline(qq + [qq[0]])
        sh.finish(color=p.get('color'), fill=p.get('fill'), width=p.get('width') or 0.5,
                  closePath=bool(p.get('closePath')), even_odd=bool(p.get('even_odd')), fill_opacity=p.get('fill_opacity') or 1)
    sh.commit()


if __name__ == '__main__':
    import json
    a, pa = load()
    a.save(os.path.join(OUT, 'BRKT-0142_rev-C.pdf'))
    b, pb = load()
    boxes = json.loads(os.environ.get('RL_BOXES', '{}'))
    edits = []
    if 'dim' in boxes:  # declared 1: change the bore callout text
        r = pymupdf.Rect(boxes['dim']); remove(pb, r)
        pb.insert_text((r.x0, r.y1 - 1), 'Ø25.5 ±0.15', fontsize=boxes.get('dimsize', 7), color=(0, 0, 1),
                       morph=(pymupdf.Point(r.x0, r.y1 - 1), pymupdf.Matrix(boxes.get('dimrot', 0))))
        edits.append(('declared', 'Bore callout Ø25 ±0.15 → Ø25.5 ±0.15', list(r)))
    if 'note' in boxes:  # declared 2: new note
        x, y = boxes['note']
        pb.insert_text((x, y), 'BREAK ALL SHARP EDGES 0.2 MAX', fontsize=7, color=(0, 0, 0))
        edits.append(('declared', 'Add note: break all sharp edges 0.2 max', [x, y - 7, x + 120, y + 2]))
    if 'hole' in boxes:  # undeclared: move a hole 3 mm
        r = pymupdf.Rect(boxes['hole']); ps = paths_in(pb, r); remove(pb, r)
        dx, dy = 3 * MM * 0.8, 3 * MM * 0.6
        redraw(pb, ps, lambda p: pymupdf.Point(p.x + dx, p.y + dy))
        edits.append(('undeclared', 'Hole moved 3 mm', list(r | (r + (dx, dy, dx, dy)))))
    if 'datum' in boxes:  # undeclared: datum feature removed
        r = pymupdf.Rect(boxes['datum']); remove(pb, r)
        edits.append(('undeclared', 'Datum feature C removed', list(r)))
    b.save(os.path.join(OUT, 'BRKT-0142_rev-D.pdf'), garbage=4, deflate=True)
    for k, pdf in (('C', a), ('D', b)):
        pymupdf.open(os.path.join(OUT, f'BRKT-0142_rev-{k}.pdf'))[0].get_pixmap(dpi=100).save(os.path.join(OUT, f'preview_{k}.png'))
    json.dump(edits, open(os.path.join(OUT, 'edits.json'), 'w'), indent=1)
    print(json.dumps(edits, indent=1))
