# TakeKit full-song + "Build band from upload" acceptance. Usage: python3 fullsong_test.py <url> [out.json]
import asyncio, base64, json, sys, os, io, wave, numpy as np
from playwright.async_api import async_playwright
URL=sys.argv[1]; OUT=sys.argv[2] if len(sys.argv)>2 else 'fullsong.json'; OD=os.path.join(os.path.dirname(os.path.abspath(OUT)),'out'); os.makedirs(OD,exist_ok=True)
QD=os.path.dirname(os.path.abspath(__file__)); F="window.__takekit"
ARGS=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+QD+'/demo-takes-92bpm-Am.wav']
HELP="""()=>{ const b64=b=>{let s=''; for(let i=0;i<b.length;i+=32768) s+=String.fromCharCode.apply(null,b.subarray(i,i+32768)); return btoa(s);}; window.__qa={b64}; }"""
# 72-bar song (3:07 at 92 BPM) rendered by TakeKit's own band = analysis + long-backing fixture
SONG=[("Intro",8,"Am F C G",.45),("Verse 1",8,"Am F C G",.7),("Chorus",8,"C G Am F",1),("Verse 2",8,"Am F C G",.7),("Chorus",8,"C G Am F",1),("Bridge",8,"F C G Am",.8),("Chorus",8,"C G Am F",1),("Verse 3",8,"Am F C G",.7),("Outro",8,"Am F C G",.45)]
async def setv(pg,k,v,o=None): return await pg.evaluate(f"([k,v,o])=>{F}.setSetting(k,v,o||undefined)",[k,v,o])
async def secs(pg,S): await pg.evaluate(f"S=>{F}.setSetting('sections',S.map(([name,bars,chords,energy])=>({{name,bars,chords,energy,lock:false}})))",S)
async def main():
  R={}; ok=lambda k,c,**d: R.__setitem__(k,dict(d,**{'pass':bool(c)}))
  async with async_playwright() as p:
    br=await p.chromium.launch(args=ARGS); ctx=await br.new_context(viewport={'width':1360,'height':1000},accept_downloads=True); pg=await ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console',lambda m: m.type=='error' and errs.append(m.text))
    await pg.goto(URL); await pg.evaluate("()=>{localStorage.clear(); indexedDB.deleteDatabase('takekit')}"); await pg.reload()
    await pg.click('#tapBtn'); await pg.wait_for_function(f"{F}.ready()",timeout=90000); await pg.evaluate(HELP)
    d=await pg.evaluate(f"()=>({{bars:{F}.state.bars,loop:{F}.state.loop,whole:{F}.state.bk.whole,regs:{F}.regions().map(r=>r.name),wav:document.getElementById('wav').textContent,play:document.getElementById('play').textContent}})")
    ok('defaults',d['bars']>=64 and not d['loop'] and d['whole'] and len(d['regs'])>=6 and 'unlock' not in d['wav'] and 'unlock' not in d['play'],**d)
    # free tier: playing the full song is never gated
    await pg.click('#play'); await pg.wait_for_timeout(800); st=await pg.evaluate(f"()=>({{p:{F}.playing(),s:document.getElementById('status').textContent}})"); await pg.click('#play')
    ok('free_play_full_song',st['p'] and 'unlock' not in st['s'].lower(),**st)
    # exact 8-bar export still 1001739 (free), full-song export gated when locked, exact when unlocked
    await setv(pg,'bars',8); r8=await pg.evaluate(f"async()=>({F}.exportWavBytes()).then(r=>r.frames)")
    await pg.evaluate(f"()=>{F}.setSetting('sections',{F}.defaultSections())"); await pg.evaluate(f"()=>{{{F}.LEMON.storeId=1;{F}.LEMON.productId=1;{F}.paintAll()}}"); await pg.click('#wav'); await pg.wait_for_timeout(400); gate=await pg.evaluate("()=>document.getElementById('expMsg').textContent"); await pg.evaluate(f"()=>{{{F}.LEMON.storeId=null;{F}.LEMON.productId=null;{F}.paintAll()}}")
    ok('export_8bar_92',r8==1001739,frames=r8); ok('export_full_gated_when_store_configured','unlock' in gate.lower(),msg=gate[:200])
    await pg.evaluate(f"()=>{{{F}.lic.valid=true}}"); await secs(pg,SONG); bars=await pg.evaluate(f"()=>{F}.state.bars")
    truth=[c.split()[i%len(c.split())] for (_,n,c,_) in SONG for i in range(n)]
    r=await pg.evaluate(f"async()=>{{const r=await {F}.exportWavBytes(); window.__fx=r; return {{frames:r.frames,name:r.name}}}}"); exp=round(bars*4*60/92*48000)
    ok('export_full_song_exact_unlocked',r['frames']==exp,frames=r['frames'],expected=exp,bars=bars,seconds=round(exp/48000,2))
    # write fixture (16-bit mono, 300 ms lead-in) to disk
    b=base64.b64decode(await pg.evaluate("()=>window.__qa.b64(window.__fx.bytes)")); w=wave.open(io.BytesIO(b)); n=w.getnframes(); raw=np.frombuffer(w.readframes(n),np.uint8).reshape(-1,3)
    v=(raw[:,0].astype(np.int32)|(raw[:,1].astype(np.int32)<<8)|(raw[:,2].astype(np.int32)<<16)); v[v>=1<<23]-=1<<24; x=(v/8388607.).reshape(-1,w.getnchannels()).mean(1)
    x=np.concatenate([np.zeros(int(0.3*48000)),x]); FX=OD+'/fixture-band-72bars-92bpm-Am.wav'; o=wave.open(FX,'wb'); o.setnchannels(1); o.setsampwidth(2); o.setframerate(48000); o.writeframes((np.clip(x,-1,1)*32767).astype('<i2').tobytes()); o.close()
    mid=await pg.evaluate(f"()=>window.__qa.b64({F}.exportMidBytes().bytes)"); open(OD+'/fixture-band.mid','wb').write(base64.b64decode(mid))
    # ---- analysis of the audio fixture, with the user's own BPM set first (must not be overwritten)
    await setv(pg,'bpm',93); await pg.evaluate(f"()=>{F}.setSetting('sections',{F}.defaultSections())")
    await pg.set_input_files('#anFile',FX); await pg.wait_for_function("window.__an.sug && document.getElementById('anApply')",timeout=120000)
    sg=await pg.evaluate("()=>window.__an.sug")
    det=[c['name'] if isinstance(c,dict) else c for c in sg['chords']]
    ch=sum(1 for i in range(min(len(truth),len(det))) if det[i]==truth[i])/len(truth)
    tb=[sum(s[1] for s in SONG[:i]) for i in range(1,len(SONG))]; db=[s['b0'] for s in sg['sections']][1:]
    miss=[t for t in tb if not any(abs(t-d)<=1 for d in db)]; extra=[d for d in db if not any(abs(t-d)<=1 for t in tb)]
    keyname=sg['key']['name'] if isinstance(sg['key'],dict) else sg['key']
    ok('analyze_bpm',abs(sg['bpm']-92)<=0.5,bpm=sg['bpm'],conf=sg.get('bpmConf'))
    ok('analyze_key',keyname.replace(' ','').lower() in ('aminor','am'),key=keyname)
    ok('analyze_chords_85pct',ch>=0.85,correct=round(ch,4),bars_true=len(truth),bars_detected=len(det))
    ok('analyze_sections_within_1bar',not miss and not extra,true=tb,detected=db,names=[s['name'] for s in sg['sections']],missing=miss,extra=extra)
    ok('analyze_offset_ms',abs(sg['offsetMs']-300)<=25,offsetMs=sg['offsetMs'])
    await pg.select_option('#anMode','band'); await pg.click('#anApply')
    a=await pg.evaluate(f"()=>({{bpm:{F}.state.bpm,key:{F}.state.key,bars:{F}.state.bars,src:{F}.state.src,secs:{F}.regions().map(r=>[r.name,r.b0,r.bars])}})")
    ok('user_bpm_not_overwritten',a['bpm']==93,**a)
    # locks survive re-analyze
    await pg.evaluate(f"()=>{{const S={F}.state.sections; S[2].name='My Hook'; S[2].chords='Dm Dm E E'; S[2].lock=true; {F}.setSetting('sections',S)}}")
    before=await pg.evaluate(f"()=>JSON.stringify({F}.state.sections[2])"); await pg.click('#anRe'); await pg.wait_for_timeout(1500)
    after=await pg.evaluate(f"()=>{F}.state.sections.map(s=>JSON.stringify(s))")
    ok('locks_survive_reanalyze',before in after and json.loads(before)['lock'],locked=json.loads(before),sections_after=len(after))
    # ---- MIDI upload
    await pg.set_input_files('#anFile',OD+'/fixture-band.mid'); await pg.wait_for_function("window.__an.sug && window.__an.sug.kind==='midi'",timeout=30000); sm=await pg.evaluate("()=>window.__an.sug")
    dm=[c['name'] if isinstance(c,dict) else c for c in sm['chords']]; cm=sum(1 for i in range(min(len(truth),len(dm))) if dm[i]==truth[i])/len(truth)
    ok('midi_upload',abs(sm['bpm']-92)<0.01 and cm>=0.85 and [s['name'] for s in sm['sections']]==[s[0] for s in SONG],bpm=sm['bpm'],chords=round(cm,4),sections=[s['name'] for s in sm['sections']],key=sm['key'])
    # ---- 3+ minute backing played start to finish in real time (backing only, whole track)
    await setv(pg,'bpm',92); await pg.set_input_files('#bkFile',FX); await pg.wait_for_function("window.__pro.isBk()",timeout=60000)
    await pg.evaluate(f"()=>{{ {F}.state.src='backing'; {F}.setSetting('fullSong',true); window.__pro.fitWhole(); }}")
    bk=await pg.evaluate(f"()=>({{bars:{F}.state.bars,dur:window.__pro.bkDur(),whole:{F}.state.bk.whole,loop:{F}.state.loop}})")
    window_s=bk['bars']*4*60/92
    await pg.evaluate("()=>{window.__bkLog=[];window.__barLog=[]}"); await pg.click('#play')
    await pg.wait_for_function(f"!{F}.playing()",timeout=int(window_s*1000+20000),polling=500)
    lg=await pg.evaluate("()=>({bar:window.__barLog,bk:(window.__bkLog||[]).slice(0,4000)})"); st=await pg.evaluate("()=>document.getElementById('status').textContent")
    bl=lg['bar']; bd=4*60/92; t0=bl[0]['time']; drift=max(abs((b['time']-t0)-b['bar']*bd)*48000 for b in bl)
    ok('backing_3min_plays_to_end',[b['bar'] for b in bl]==list(range(bk['bars'])) and bk['dur']>=180 and drift<0.5,**bk,bars_played=len(bl),last_bar=bl[-1]['bar'],max_drift_samples=round(drift,4),status=st[:120],bkLog_entries=len(lg['bk']))
    # ---- built-in band full song at 180 BPM: every section in order
    await pg.evaluate(f"()=>{{ {F}.state.src='band'; }}"); await setv(pg,'bpm',180); await pg.evaluate(f"()=>{F}.setSetting('sections',{F}.defaultSections())")
    await pg.evaluate(f"()=>{{window.__barLog=[]; {F}.seekBar(0)}}"); await pg.click('#play'); ws=64*4*60/180
    await pg.wait_for_function(f"!{F}.playing()",timeout=int(ws*1000+20000),polling=500); bl=await pg.evaluate("()=>window.__barLog")
    seq=[]; [seq.append(b['sec']) for b in bl if not seq or seq[-1]!=b['sec']]; regs=await pg.evaluate(f"()=>{F}.regions().map(r=>r.name)")
    ok('band_full_song_sections_in_order',[b['bar'] for b in bl]==list(range(64)) and seq==regs,sections_played=seq,bars=len(bl))
    # ---- loop toggle confines playback to one section
    await setv(pg,'loop',True); await setv(pg,'loopSec',2); await pg.evaluate("()=>{window.__barLog=[]}"); await pg.click('#play'); await pg.wait_for_timeout(int(8*4*60/180*1000*2.3)); await pg.click('#play')
    lb=[b['bar'] for b in await pg.evaluate("()=>window.__barLog")]
    ok('loop_toggle_one_section',lb and all(16<=b<24 for b in lb) and lb.count(16)>=2,bars=lb)
    await setv(pg,'loop',False)
    # ---- full-song take scoring + comp + guide + lyrics past bar 8 (92 BPM, 64 bars)
    await setv(pg,'bpm',92); await pg.evaluate(f"()=>{F}.setSetting('sections',{F}.defaultSections())")
    w=wave.open(QD+'/demo-takes-92bpm-Am.wav'); dv=np.frombuffer(w.readframes(w.getnframes()),'<i2'); L=round(64*4*60/92*48000); L8=round(8*4*60/92*48000)
    for k,order in enumerate([[0,1,2,3,0,1,2,3],[3,2,1,0,3,2,1,0]]):
      t=np.concatenate([dv[i*L8:(i+1)*L8] for i in order])[:L]; t=np.pad(t,(0,L-len(t))); bio=io.BytesIO(); o=wave.open(bio,'wb'); o.setnchannels(1); o.setsampwidth(2); o.setframerate(48000); o.writeframes(t.astype('<i2').tobytes()); o.close()
      await pg.evaluate("async ([b,n])=>await window.__takekit.importBytes(b,n)",[base64.b64encode(bio.getvalue()).decode(),f'full{k}.wav'])
    sc=await pg.evaluate(f"()=>{{const f={F}, s=f.scoresFor('voice'), c=f.comps(); const ids=f.takes().filter(t=>/full/.test(t.name)).map(t=>t.id); return {{segs:s.segs.length, scored:s.segs.filter(g=>ids.every(i=>g.cells[i] && g.cells[i].score!=null)).length, comp:c.voice.choice.length, picked:c.voice.choice.filter(x=>x).length, takes:f.takes().length}}}}")
    ok('full_song_scoring_and_comp',sc['segs']==64 and sc['scored']==64 and sc['comp']==64 and sc['picked']>=56,**sc)
    gl=await pg.evaluate("async()=>{const t=window.__takekit.takes().find(t=>/full0/.test(t.name)); await window.__pro.guideFromTake(t.id); return window.__pro.hasGuide()}")
    lt=await pg.evaluate(f"""()=>{{ const ta=document.getElementById('lyrText'); ta.value='line one\\nline at bar 41\\nline three'; ta.dispatchEvent(new Event('input',{{bubbles:true}}));
      const bd=4*60/92; {F}.state.lyr.times=[0, 40*bd, 60*bd]; {F}.state.lyr.words=[]; window.__pro.paint(); return [...document.querySelectorAll('#lyrList [data-li]')].length }}""")
    await pg.evaluate(f"()=>{F}.seekBar(39)"); await pg.click('#play'); await pg.wait_for_timeout(int(4*60/92*1000*1.6)+500)
    cur=await pg.evaluate("()=>{const e=document.querySelector('#lyrList .cur'); return e?e.getAttribute('data-li'):null}"); pos=await pg.evaluate("()=>document.getElementById('pos').textContent")
    await pg.screenshot(path=OD+'/fullsong.png',full_page=False); await pg.click('#play')
    ok('lyric_past_bar8_highlights',cur=='1',current_line=cur,pos=pos,lines=lt); ok('guide_from_full_take',gl)
    # ---- record a full (non-looped) song take and a looped-section take
    await setv(pg,'bpm',180); await secs(pg,[("A",4,"Am F C G",.8),("B",4,"C G Am F",1)])
    await pg.evaluate(f"()=>{F}.seekBar(0)"); n0=await pg.evaluate(f"()=>{F}.takes().length"); await pg.click('#rec')
    await pg.wait_for_function(f"!{F}.recording() && {F}.takes().length>{n0}",timeout=30000)
    t1=await pg.evaluate(f"()=>{{const t={F}.takes().at(-1); return {{region:t.region, n:(t.data||t.pcm||[]).length}}}}")
    await setv(pg,'loop',True); await setv(pg,'loopSec',1); n1=await pg.evaluate(f"()=>{F}.takes().length"); await pg.click('#rec'); await pg.wait_for_timeout(int(4*4*60/180*1000*1.3)+1200); await pg.click('#rec') 
    await pg.wait_for_timeout(1500); t2=await pg.evaluate(f"()=>{F}.takes().slice({n1}).map(t=>t.region)")
    ok('record_full_and_loop_regions',t1['region'] in ([0,8],{'b0':0,'b1':8}) and t2 and t2[0] in ([4,8],{'b0':4,'b1':8}) and all(r[0]==4 and r[1]<=8 for r in t2),full=t1,loop=t2)
    # ---- persistence
    await pg.reload(); await pg.click('#tapBtn'); await pg.wait_for_function(f"{F}.ready()",timeout=90000)
    ps=await pg.evaluate(f"()=>({{loop:{F}.state.loop,loopSec:{F}.state.loopSec,secs:{F}.regions().map(r=>r.name),bpm:{F}.state.bpm}})")
    ok('settings_persist',ps['loop'] and ps['loopSec']==1 and ps['secs']==['A','B'] and ps['bpm']==180,**ps)
    R['errors']=errs; R['all_pass']=all(v['pass'] for k,v in R.items() if isinstance(v,dict)) and not errs
    await br.close()
  json.dump(R,open(OUT,'w'),indent=1); print(json.dumps({k:(v['pass'] if isinstance(v,dict) else v) for k,v in R.items()},indent=0))
asyncio.run(main())
