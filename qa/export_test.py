# TakeKit export acceptance on WebKit (iPhone 13 emulation) + Chromium. Usage: python3 export_test.py <url> [out.json]
# Default 64-bar band song: WAV / MIDI / stems ZIP / LRC via the real buttons (downloads), exact lengths; section + bar-range
# export; 92 BPM 8 bars = 1,001,739 frames; uploaded 3-minute backing full export; iOS share-sheet path (navigator.share stub).
import asyncio, json, sys, os, io, wave, zipfile, numpy as np, mido
from playwright.async_api import async_playwright
URL=sys.argv[1]; OUT=sys.argv[2] if len(sys.argv)>2 else 'export.json'; OD=os.path.join(os.path.dirname(os.path.abspath(OUT)),'out-export'); os.makedirs(OD,exist_ok=True)
QD=os.path.dirname(os.path.abspath(__file__)); F="window.__takekit"
def frames(b): w=wave.open(io.BytesIO(b)); return w.getnframes(), w.getframerate(), w.getsampwidth(), w.getnchannels()
def rms(b):
  w=wave.open(io.BytesIO(b)); raw=np.frombuffer(w.readframes(w.getnframes()),np.uint8).reshape(-1,3); v=(raw[:,0].astype(np.int32)|(raw[:,1].astype(np.int32)<<8)|(raw[:,2].astype(np.int32)<<16)); v[v>=1<<23]-=1<<24; return float(np.sqrt(np.mean((v/8388607.)**2)))
def backing3min():
  p=OD+'/backing-3min.wav'
  if os.path.exists(p): return p
  w=wave.open(QD+'/demo-takes-92bpm-Am.wav'); x=np.frombuffer(w.readframes(w.getnframes()),'<i2'); n=180*48000; y=np.resize(x,n)
  o=wave.open(p,'wb'); o.setnchannels(2); o.setsampwidth(2); o.setframerate(48000); o.writeframes(np.repeat(y,2).astype('<i2').tobytes()); o.close(); return p
async def dl(pg,sel,timeout=240000):
  await pg.evaluate("()=>document.activeElement&&document.activeElement.blur()"); await pg.locator(sel).scroll_into_view_if_needed()
  async with pg.expect_download(timeout=timeout) as d: await pg.click(sel)
  d=await d.value; fp=OD+'/'+pg.__tag+'-'+d.suggested_filename; await d.save_as(fp); return d.suggested_filename, open(fp,'rb').read()
async def run(p, tag, R):
  ok=lambda k,c,**d: R.__setitem__(tag+':'+k,dict(d,**{'pass':bool(c)}))
  if tag=='webkit-iphone': br=await p.webkit.launch(); ctx=await br.new_context(**p.devices['iPhone 13'],accept_downloads=True)
  else: br=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); ctx=await br.new_context(viewport={'width':1360,'height':1000},accept_downloads=True)
  pg=await ctx.new_page(); pg.__tag=tag; errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
  await pg.goto(URL); await pg.evaluate("()=>{localStorage.clear(); indexedDB.deleteDatabase('takekit')}"); await pg.reload(); errs.clear()
  await pg.click('#tapBtn'); await pg.wait_for_function(f"{F}.ready()",timeout=120000)
  st=await pg.evaluate(f"()=>({{bars:{F}.state.bars,bpm:{F}.state.bpm,ios:!document.getElementById('ios').hidden,note:document.getElementById('expNote').textContent,wav:document.getElementById('wav').textContent,gated:{F}.gated()}})")
  bars,bpm=st['bars'],st['bpm']; exp=lambda b: round(b*4*60/bpm*48000)
  ok('default_song_not_gated',bars>=64 and not st['gated'] and 'free until checkout opens' in st['note'].lower() and 'unlock' not in st['wav'],**st)
  await pg.locator('#wav').scroll_into_view_if_needed()
  n,b=await dl(pg,'#wav'); f=frames(b); msg=await pg.text_content('#expMsg')
  ok('wav_full_song',f[0]==exp(bars) and f[1:]==(48000,3,2) and rms(b)>1e-3,file=n,frames=f[0],expected=exp(bars),bars=bars,msg=msg)
  n,b=await dl(pg,'#mid'); m=mido.MidiFile(file=io.BytesIO(b)); tpb=m.ticks_per_beat; L=max(sum(x.time for x in t) for t in m.tracks)
  ok('midi_full_song',L==bars*4*tpb,file=n,ticks=L,expected=bars*4*tpb,tracks=len(m.tracks))
  n,b=await dl(pg,'#stems'); z=zipfile.ZipFile(io.BytesIO(b)); names=z.namelist(); wl=[frames(z.read(x))[0] for x in names if x.endswith('.wav')]
  ok('stems_zip_full_song',len(wl)>=3 and all(x==exp(bars) for x in wl) and any(x.endswith('.mid') for x in names) and z.testzip() is None,files=names,frames=sorted(set(wl)),expected=exp(bars))
  await pg.fill('#lyrText','Hello from the top\nSecond line here\n\nThird line'); await pg.click('#lyrAuto')
  n,b=await dl(pg,'#lyrLrc'); t=b.decode(); lt=[l for l in t.splitlines() if l.startswith('[length:')]
  mm,ss=divmod(bars*4*60/bpm,60); ok('lrc',n.endswith('.lrc') and len(lt)==1 and t.count('Hello from the top')==1,file=n,length=lt,song_s=round(bars*4*60/bpm,2))
  # section export (Chorus = 3rd section) and a bar range, through the "What to export" picker
  R2=await pg.evaluate(f"()=>{F}.regions().map(r=>[r.name,r.b0,r.b1])"); s=R2[2]
  await pg.select_option('#expScope','sec:2'); n,b=await dl(pg,'#wav'); ok('section_wav',frames(b)[0]==exp(s[2])-exp(s[1]) and 'bars3' not in n,section=s,file=n,frames=frames(b)[0],expected=exp(s[2])-exp(s[1]))
  n,b=await dl(pg,'#mid'); m=mido.MidiFile(file=io.BytesIO(b)); L=max(sum(x.time for x in t) for t in m.tracks); ok('section_midi',L==(s[2]-s[1])*4*m.ticks_per_beat,file=n,ticks=L)
  await pg.select_option('#expScope','range'); await pg.fill('#expFrom','5'); await pg.fill('#expTo','12'); await pg.dispatch_event('#expTo','change')
  n,b=await dl(pg,'#wav'); ok('range_wav_5_12',frames(b)[0]==exp(12)-exp(4),file=n,frames=frames(b)[0],expected=exp(12)-exp(4))
  # store configured (in memory only): full song locks, a section still exports free
  await pg.evaluate(f"()=>{{{F}.LEMON.storeId=1;{F}.LEMON.productId=1;{F}.paintAll()}}"); await pg.select_option('#expScope','song'); await pg.click('#wav'); await pg.wait_for_timeout(300); g=await pg.text_content('#expMsg')
  await pg.select_option('#expScope','sec:1'); n,b=await dl(pg,'#wav'); ok('gate_resumes_when_configured_section_still_free','unlock' in g.lower() and frames(b)[0]==exp(R2[1][2])-exp(R2[1][1]),msg=g[:160],section_file=n)
  await pg.evaluate(f"()=>{{{F}.LEMON.storeId=null;{F}.LEMON.productId=null;{F}.paintAll()}}"); await pg.select_option('#expScope','song')
  # 92 BPM 8 bars
  await pg.evaluate(f"()=>{F}.setSetting('bpm',92)"); await pg.evaluate(f"()=>{F}.setSetting('bars',8)"); n,b=await dl(pg,'#wav'); ok('wav_92bpm_8bar',frames(b)[0]==1001739,file=n,frames=frames(b)[0])
  # sung takes + default vocal chain (Clean Pop, IR reverb) through the offline render, at the live context's own sample rate
  await pg.set_input_files('#impFile',QD+'/demo-takes-92bpm-Am.wav'); await pg.wait_for_function(f"{F}.takes().length>0",timeout=60000)
  nt=await pg.evaluate(f"()=>({{n:{F}.takes().length,chain:{F}.state.chain.on,sr:{F}.ctx()&&{F}.ctx().sampleRate}})")
  n,b=await dl(pg,'#wav'); n2,b2=await dl(pg,'#stems'); z=zipfile.ZipFile(io.BytesIO(b2)); vn=[x for x in z.namelist() if 'vocal' in x or 'raw-' in x]
  ok('wav_and_stems_with_vocal_takes_chain_on',frames(b)[0]==1001739 and nt['n']>0 and nt['chain'] and len(vn)>=3 and all(frames(z.read(x))[0]==1001739 for x in vn) and rms(z.read([x for x in vn if 'chain' in x][0]))>1e-4,takes=nt,vocal_stems=vn)
  # uploaded 3-minute backing, whole track
  await pg.select_option('#src','backing'); await pg.set_input_files('#bkFile',backing3min()); await pg.wait_for_function("window.__pro && window.__pro.isBk()",timeout=60000); await pg.wait_for_timeout(500)
  bk=await pg.evaluate(f"()=>({{bars:{F}.state.bars,bpm:{F}.state.bpm,whole:{F}.state.bk.whole}})"); await pg.select_option('#expScope','song')
  if not await pg.is_checked('#bkInc'): await pg.check('#bkInc')
  n,b=await dl(pg,'#wav'); e3=round(bk['bars']*4*60/bk['bpm']*48000); r=rms(b)
  ok('backing_3min_full_export',frames(b)[0]==e3 and e3/48000>=170 and r>1e-3,file=n,frames=frames(b)[0],expected=e3,seconds=round(e3/48000,1),rms=round(r,4),**bk)
  n,b=await dl(pg,'#stems'); z=zipfile.ZipFile(io.BytesIO(b)); wl=[frames(z.read(x))[0] for x in z.namelist() if x.endswith('.wav')]; ok('backing_3min_stems',all(x==e3 for x in wl) and any('backing' in x for x in z.namelist()),files=z.namelist())
  # chunked render == single render (forced tiny chunks)
  cmp=await pg.evaluate(f"""async()=>{{ window.__tkChunkS=1e6; const a=await {F}.renderMix({{noNorm:true}}); window.__tkChunkS=20; const b=await {F}.renderMix({{noNorm:true}}); window.__tkChunkS=0;
    let d=0,p=0; for(let c=0;c<2;c++) for(let i=0;i<a.N;i++){{d=Math.max(d,Math.abs(a.ch[c][i]-b.ch[c][i])); p=Math.max(p,Math.abs(a.ch[c][i]));}} return {{N:a.N,Nb:b.N,chunks:b.chunks,diff_db:20*Math.log10(d/p+1e-12)}} }}""")
  ok('chunked_matches_single',cmp['N']==cmp['Nb'] and cmp['chunks']>1 and cmp['diff_db']<-40,**cmp)
  if tag=='webkit-iphone':
    # iOS share-sheet path: stub navigator.share/canShare; the File must reach the share sheet with the right name, type and size
    await pg.evaluate("()=>{window.__shared=[]; navigator.canShare=d=>!!(d&&d.files&&d.files.length); navigator.share=async d=>{window.__shared.push(d.files.map(f=>({name:f.name,type:f.type,size:f.size})))}}")
    await pg.evaluate(f"()=>{F}.setSetting('bars',8)"); await pg.click('#mid'); await pg.wait_for_timeout(800); sh=await pg.evaluate("()=>window.__shared"); msg=await pg.text_content('#expMsg')
    await pg.evaluate("()=>{navigator.share=async()=>{throw new DOMException('no gesture','NotAllowedError')}}"); await pg.click('#mid'); await pg.wait_for_timeout(500); m2=await pg.text_content('#expMsg'); btn=await pg.is_visible('#saveBtn')
    ok('ios_share_sheet',len(sh)==1 and sh[0][0]['name'].endswith('.mid') and sh[0][0]['size']>0 and 'shared' in msg.lower() and btn and 'tap' in m2.lower(),shared=sh,msg=msg,no_gesture_msg=m2,save_button=btn)
    await pg.locator('section.export').screenshot(path=OD+'/export-iphone.png')
  ok('no_page_errors',not errs,errors=errs[:5]); await br.close()
async def main():
  R={}
  async with async_playwright() as p:
    for tag in ['webkit-iphone','chromium']:
      try: await run(p,tag,R)
      except Exception as e: R[tag+':crash']={'pass':False,'error':repr(e)[:600]}
  json.dump(R,open(OUT,'w'),indent=1); bad=[k for k,v in R.items() if not v['pass']]
  for k,v in R.items(): print(('PASS ' if v['pass'] else 'FAIL ')+k, json.dumps({a:b for a,b in v.items() if a!='pass'})[:300])
  print('ALL PASS' if not bad else 'FAILED: '+', '.join(bad)); sys.exit(1 if bad else 0)
asyncio.run(main())
