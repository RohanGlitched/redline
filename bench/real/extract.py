import subprocess, json, os
targets = [('SparkFun_GNSSDO','Hardware/Schematic.pdf'),('SparkFun_GNSSDO','Hardware/GNSSDO_Plus/Schematic.pdf'),('SparkFun_GNSSDO','docs/assets/board_files/dimensions.pdf'),
           ('SparkFun_GNSS_Flex_Breakout','Hardware/Schematic.pdf'),('SparkFun_IM19_IMU_Breakout','Hardware/Schematic.pdf'),
           ('SparkFun_GNSS_mosaic-G5_P3','Hardware/Schematic.pdf'),('SparkFun_Thing_Plus_RA6M5','Hardware/SparkFun_Thing_Plus_RA6M5.pdf')]
out = []
for repo, path in targets:
    log = subprocess.run(['git','-C',repo,'log','--all','--reverse','--format=%H%x1f%ad%x1f%s%x1f%b%x1e','--date=short','--',path],capture_output=True,text=True,encoding='utf-8').stdout
    commits = [c.strip('\n').split('\x1f') for c in log.split('\x1e') if c.strip()]
    vers = []
    for i,(h,date,subj,body) in enumerate(commits):
        f = f'pdfs/{repo}__{path.replace("/","_")}__{i:02d}.pdf'
        os.makedirs('pdfs', exist_ok=True)
        b = subprocess.run(['git','-C',repo,'show',f'{h}:{path}'],capture_output=True).stdout
        if not b.startswith(b'%PDF'): continue
        open(f,'wb').write(b)
        vers.append({'i':i,'hash':h[:10],'date':date,'subject':subj,'body':body.strip()[:500],'file':f,'size':len(b)})
    out.append({'repo':repo,'path':path,'versions':vers})
    print(repo, path, len(vers), [ (v['date'], v['subject'][:50]) for v in vers])
json.dump(out, open('versions.json','w'), indent=1)
