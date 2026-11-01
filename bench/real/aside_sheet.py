import json, numpy as np, cv2
R=json.load(open('results.json')); J={j['name']+j['path']: j for j in json.load(open('jobs.json'))}
def pgm(f): return cv2.imread(f, cv2.IMREAD_GRAYSCALE)
tiles=[]
for j in R:
    job=J[j['name']+j['path']]
    for p,jp in zip(j['pages'], job['pages']):
        for a in p.get('setAside',[]):
            A=pgm(jp['A']); B=pgm(jp['B'])
            x0,y0,x1,y1=a['box']; pad=30
            X0,Y0=max(0,x0-pad),max(0,y0-pad); X1,Y1=min(A.shape[1],x1+pad),min(A.shape[0],y1+pad)
            ca=A[Y0:Y1,X0:X1]; cb=B[Y0:min(Y1,B.shape[0]),X0:min(X1,B.shape[1])]
            h=max(ca.shape[0],cb.shape[0]); 
            def fit(c):
                c=cv2.copyMakeBorder(c,0,h-c.shape[0],0,0,cv2.BORDER_CONSTANT,value=255); return c
            s=180/max(h,1); 
            row=np.hstack([fit(ca),np.full((h,6),200,np.uint8),fit(cb)])
            s=min(3,180/max(h,1),520/row.shape[1]); row=cv2.resize(row,(max(1,int(row.shape[1]*s)),max(1,int(h*s))),interpolation=cv2.INTER_AREA if s<1 else cv2.INTER_NEAREST)
            row=cv2.cvtColor(row,cv2.COLOR_GRAY2BGR)
            lab=f"{len(tiles)+1}. {j['name'].split('__')[0].replace('SparkFun_','')} p{p['page']} match {a['match']}"
            canvas=np.full((row.shape[0]+26,max(row.shape[1],420),3),255,np.uint8); canvas[26:,:row.shape[1]]=row
            cv2.putText(canvas,lab,(4,18),cv2.FONT_HERSHEY_SIMPLEX,0.5,(40,40,40),1,cv2.LINE_AA)
            tiles.append(canvas)
W=max(t.shape[1] for t in tiles); cols=3
rows=[]
for i in range(0,len(tiles),cols):
    grp=[cv2.copyMakeBorder(t,6,6,6,6+W-t.shape[1],cv2.BORDER_CONSTANT,value=(255,255,255)) for t in tiles[i:i+cols]]
    H=max(g.shape[0] for g in grp); grp=[cv2.copyMakeBorder(g,0,H-g.shape[0],0,0,cv2.BORDER_CONSTANT,value=(255,255,255)) for g in grp]
    while len(grp)<cols: grp.append(np.full((H,W+12,3),255,np.uint8))
    rows.append(np.hstack(grp))
img=np.vstack(rows); cv2.imwrite('set_aside_all.png',img); print(len(tiles), img.shape)
