import json, os, pymupdf
vs = json.load(open('versions.json'))
jobs = []
for d in vs:
    v = d['versions']
    for a, b in zip(v, v[1:]):
        name = f"{d['repo']}__{os.path.basename(d['path'])[:-4]}__{a['i']:02d}-{b['i']:02d}"
        os.makedirs(f'pairs/{name}', exist_ok=True)
        A, B = pymupdf.open(a['file']), pymupdf.open(b['file'])
        pages = []
        for p in range(max(len(A), len(B))):
            item = {'page': p + 1}
            for tag, doc in (('A', A), ('B', B)):
                if p < len(doc):
                    pg = doc[p]; pg.remove_rotation()
                    pix = pg.get_pixmap(dpi=150, colorspace=pymupdf.csGRAY)
                    f = f'pairs/{name}/{tag}{p+1}.pgm'; pix.save(f)
                    item[tag] = f
                    item[tag + 'words'] = [[w[0]*150/72, w[1]*150/72, w[2]*150/72, w[3]*150/72, w[4]] for w in pg.get_text('words')]
            pages.append(item)
        jobs.append({'name': name, 'repo': d['repo'], 'path': d['path'], 'from': a, 'to': b, 'pages': pages})
json.dump(jobs, open('jobs.json', 'w'))
print(len(jobs), 'pairs', sum(len(j['pages']) for j in jobs), 'page pairs')
