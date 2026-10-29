# TakeKit Pro features QA: backing track, vocal chain, guide vocal, lyric timer. Usage: python3 qa/pro_test.py <url> [out.json]
import asyncio, base64, json, sys, io, os, wave, zipfile, re, numpy as np, mido
from playwright.async_api import async_playwright
URL=sys.argv[1]; OUT=sys.argv[2] if len(sys.argv)>2 else 'pro.json'; OD=os.path.join(os.path.dirname(os.path.abspath(OUT)),'out'); os.makedirs(OD,exist_ok=True)
QD=os.path.dirname(os.path.abspath(__file__)); FX=QD+'/fixtures'; os.makedirs(FX,exist_ok=True); F="window.__takekit"; P="window.__pro"
ARGS=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+QD+'/demo-takes-92bpm-Am.wav']
HELP="""()=>{ const f=window.__takekit; const b64=b=>{let s=''; for(let i=0;i<b.length;i+=32768) s+=String.fromCharCode.apply(null,b.subarray(i,i+32768)); return btoa(s);};
 window.__qa={ b64, wav: async o=>{ const r=await f.exportWavBytes(o||{}); return {name:r.name,b64:b64(r.bytes),frames:r.frames}; } }; }"""
PAD=0.300; EXP=1001739
LYR="[Verse 1]\nShadows on the wall\nI keep calling out your name\nNothing comes back now\nStill I sing it anyway\n\nLights along the road\nevery mile a little slower\nhold the last note long\nlet it ring until it's over\n"
def load(b):
  w=wave.open(io.BytesIO(b)); n=w.getnframes()
  if w.getsampwidth()==2: return w.getframerate(),n,(np.frombuffer(w.readframes(n),dtype='<i2')/32768.0).reshape(-1,w.getnchannels())
  raw=np.frombuffer(w.readframes(n),dtype=np.uint8).reshape(-1,3)
  v=(raw[:,0].astype(np.int32)|(raw[:,1].astype(np.int32)<<8)|(raw[:,2].astype(np.int32)<<16)); v[v>=1<<23]-=1<<24
  return w.getframerate(),n,(v/8388607.0).reshape(-1,w.getnchannels())
def save24(fn,x,sr=48000):
  x=np.clip(x,-1,1); v=np.round(x*8388607).astype(np.int32); v[v<0]+=1<<24; b=np.stack([v&255,(v>>8)&255,(v>>16)&255],-1).astype(np.uint8).reshape(-1)
  w=wave.open(fn,'wb'); w.setnchannels(x.shape[1]); w.setsampwidth(3); w.setframerate(sr); w.writeframes(b.tobytes()); w.close()
async def wav(pg,o=None): r=await pg.evaluate("o=>window.__qa.wav(o)",o or {}); return load(base64.b64decode(r['b64']))
async def boot(pg):
  await pg.click('#tapBtn'); await pg.wait_for_function("document.getElementById('tap').classList.contains('hide')"); await pg.evaluate(HELP); await pg.wait_for_function(f"{F}.ready()",timeout=90000); await pg.evaluate(f"()=>{P}.ready")
async def setv(pg,k,v): return await pg.evaluate(f"([k,v])=>{F}.setSetting(k,v)",[k,v])
db=lambda a: round(float(20*np.log10(a+1e-12)),2)
async def main():
  R={}
  async with async_playwright() as p:
    br=await p.chromium.launch(args=ARGS); ctx=await br.new_context(viewport={'width':1360,'height':1000}); pg=await ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console',lambda m: m.type=='error' and errs.append(m.text))
    await pg.goto(URL); await pg.evaluate("()=>{localStorage.clear(); indexedDB.deleteDatabase('takekit')}"); await pg.reload(); await boot(pg); await setv(pg,'bars',8)
    R['defaults']=await pg.evaluate(f"()=>({{src:{F}.state.src, chain:{F}.state.chain.preset, chainOn:{F}.state.chain.on, recOnly:{F}.state.guide.recOnly}})")
    # ---- fixture backing = TakeKit's own band export (real samples), padded with 300 ms of silence, two loops long
    sr,n,band=await wav(pg); assert n==EXP
    fx=np.vstack([np.zeros((int(PAD*48000),2)),band,band]); save24(FX+'/backing-92bpm-Am-pad300.wav',fx)
    demo=load(open(QD+'/demo-takes-92bpm-Am.wav','rb').read())[2]; g=demo[:EXP]; g=g if g.ndim==2 else g[:,None]
    save24(FX+'/guide-92bpm-Am-pad300.wav',np.vstack([np.zeros((int(PAD*48000),g.shape[1])),g]))
    open(FX+'/not-audio.mp3','w').write('this is a text file pretending to be an mp3\n'*50)
    # ---- bad file
    await pg.select_option('#src','backing'); await pg.set_input_files('#bkFile',FX+'/not-audio.mp3'); await pg.wait_for_timeout(800)
    R['bad_file']={'msg':await pg.text_content('#bkErr'),'loaded':await pg.evaluate(f"()=>{P}.isBk()")}; R['bad_file']['pass']="can't decode" in R['bad_file']['msg'] and not R['bad_file']['loaded']
    # ---- upload backing, user BPM respected, offset, alignment
    await pg.set_input_files('#bkFile',FX+'/backing-92bpm-Am-pad300.wav'); await pg.wait_for_function(f"{P}.isBk()")
    R['default_whole_track']={'whole':await pg.evaluate(f"()=>{F}.state.bk.whole"),'bars':await pg.evaluate(f"()=>{F}.state.bars")}; R['default_whole_track']['pass']=R['default_whole_track']['whole'] and R['default_whole_track']['bars']==16
    await pg.uncheck('#bkWhole'); await setv(pg,'bars',8)  # the 8-bar alignment/loop checks below opt out of whole-track
    await setv(pg,'bpm',100); await pg.wait_for_timeout(200); sug=await pg.text_content('#bkBpm'); bpm_after=await pg.evaluate(f"()=>{F}.state.bpm"); await setv(pg,'bpm',92)
    R['bpm']={'suggestion':sug,'user_bpm_kept':bpm_after==100,'pass':bpm_after==100 and '92 BPM' in sug}
    await pg.fill('#bkOff','300'); await pg.press('#bkOff','Tab'); await pg.evaluate(f"()=>{{ {F}.state.bk.vol=1; }}")
    _,nb,xb=await wav(pg,{'only':['backing'],'gain':1,'noNorm':True}); m=np.abs(xb).max(1); fi=int(np.argmax(m>0.01*m.max()))
    a=xb[:nb-64,0]; b=band[:nb-64,0]; cc=[float(np.dot(a[48000:96000],b[48000+L:96000+L])) for L in range(-48,49)]; lag=int(np.argmax(cc))-48
    R['alignment']={'frames':nb,'expected':EXP,'first_transient_ms':round(fi/48,3),'band_first_transient_ms':round(int(np.argmax(np.abs(band).max(1)>0.01*np.abs(band).max()))/48,3),'xcorr_lag_samples':lag,'maxdiff_vs_band_export_dBFS':db(np.abs(xb[:nb-64]-band[:nb-64]).max())}
    R['alignment']['pass']=nb==EXP and lag==0 and fi/48<=1.0 and np.abs(xb[:nb-64]-band[:nb-64]).max()<1e-4
    # ---- whole-track mode
    await pg.check('#bkWhole'); whole=await pg.evaluate(f"()=>{F}.state.bars"); await pg.uncheck('#bkWhole'); R['whole_track']={'bars':whole,'pass':whole==16 and await pg.evaluate(f"()=>{F}.state.bars")==8}
    # ---- loop drift over 4 loops (4 bars @ 92 = 10.43 s per loop) + takes share the grid
    await setv(pg,'loop',True); await setv(pg,'bars',4); await pg.evaluate("()=>{window.__bkLog.length=0; window.__schedLog.length=0}"); await pg.click('#play'); await pg.wait_for_timeout(int(4*4*60/92*4*1000)+2500); await pg.click('#play')
    lg=await pg.evaluate("()=>window.__bkLog"); sl=await pg.evaluate("()=>window.__schedLog.filter(e=>e.step===0).map(e=>e.time)")
    bd=4*60/92; t0=lg[0]['t']; dr=[(e['t']-(t0+i*bd))*48000 for i,e in enumerate(lg)]; offs=[round(e['off'],6) for e in lg]
    R['loop_drift']={'bars_scheduled':len(lg),'loops':len(lg)/4,'max_drift_samples':round(max(abs(x) for x in dr),6),'file_offsets_per_loop':[offs[i:i+4] for i in range(0,16,4)],
      'loop_starts_equal_take_pass_starts':all(any(abs(e['t']-s)<1e-9 for s in sl) for e in lg if e['bar']==0)}
    R['loop_drift']['pass']=len(lg)>=16 and R['loop_drift']['max_drift_samples']<0.5 and all(offs[i]==offs[i%4] for i in range(16)) and R['loop_drift']['loop_starts_equal_take_pass_starts']
    _,n4,x4=await wav(pg,{'only':['backing'],'gain':1,'noNorm':True}); t4=np.tile(x4,(4,1)); d=np.abs(np.diff(t4[:,0])); seam=[float(d[k*n4-1]) for k in (1,2,3)]
    R['loop_drift']['export_4bar_frames']=n4; R['loop_drift']['export_4bar_expected']=round(4*4*60/92*48000); R['loop_drift']['tiled_seam_steps']=[round(s,5) for s in seam]; R['loop_drift']['sample_step_p99.9']=round(float(np.percentile(d,99.9)),5)
    R['loop_drift']['pass']&= n4==round(4*4*60/92*48000) and max(seam)<=float(np.percentile(d,99.9))
    await setv(pg,'bars',8)
    # ---- import takes, include/exclude backing in the mix
    b64=base64.b64encode(open(QD+'/demo-takes-92bpm-Am.wav','rb').read()).decode(); await pg.evaluate("async b=>await window.__takekit.importBytes(b,'demo.wav')",b64)
    _,ni,xi=await wav(pg,{'gain':0.5,'noNorm':False}); await pg.uncheck('#bkInc'); _,ne,xe=await wav(pg,{'gain':0.5}); _,nv,xv=await wav(pg,{'only':['voice'],'gain':0.5}); await pg.check('#bkInc')
    R['include_exclude']={'frames':[ni,ne],'excluded_equals_vocal_only_maxdiff_dBFS':db(np.abs(xe-xv).max()),'included_minus_excluded_vs_backing_corr':round(float(np.corrcoef((xi-xe)[:,0],xb[:,0])[0,1]),4)}
    R['include_exclude']['pass']=ni==ne==EXP and np.abs(xe-xv).max()<1e-6 and R['include_exclude']['included_minus_excluded_vs_backing_corr']>0.99
    # ---- vocal chain
    full=await pg.evaluate(f"()=>JSON.parse(JSON.stringify({F}.state.chain))")
    await pg.evaluate(f"()=>{{ const c={F}.state.chain; for(const k of ['hpf','sub','deess','comp','tone','sat','verb','delay']) c[k].on=false; c.trim=0; c.on=true; }}")
    _,_,xby=await wav(pg,{'only':['voice'],'gain':1,'noNorm':True,'dry':False}); _,_,xdr=await wav(pg,{'only':['voice'],'gain':1,'noNorm':True,'dry':True})
    await pg.evaluate(f"()=>{{ {F}.state.chain.on=false; }}"); _,_,xoff=await wav(pg,{'only':['voice'],'gain':1,'noNorm':True,'dry':False})
    await pg.evaluate("c=>{ Object.assign(window.__takekit.state.chain, c); }",full)
    _,_,c1=await wav(pg,{'only':['voice'],'gain':1,'noNorm':True,'dry':False}); _,_,c2=await wav(pg,{'only':['voice'],'gain':1,'noNorm':True,'dry':False})
    R['chain']={'default_preset':full['preset'],'null_all_stages_bypassed_vs_dry_dBFS':db(np.abs(xby-xdr).max()),'null_chain_off_vs_dry_dBFS':db(np.abs(xoff-xdr).max()),
      'repeat_render_maxdiff_dBFS':db(np.abs(c1-c2).max()),'chain_vs_dry_rms_diff_dBFS':db(float(np.sqrt(((c1-xdr)**2).mean())))}
    pres={}
    for nm in ['Off','Clean Pop','Warm Ballad','Rap Upfront','Airy R&B','Rock Grit']:
      await pg.select_option('#chPreset',nm); st=await pg.evaluate(f"()=>({{p:{F}.state.chain.preset,on:{F}.state.chain.on,ui:document.querySelectorAll('#chainUI fieldset').length}})")
      _,nn,xx=await wav(pg); _,_,ya=await wav(pg,{'only':['voice'],'gain':1,'noNorm':True}); _,_,yb=await wav(pg,{'only':['voice'],'gain':1,'noNorm':True})
      pres[nm]={'state':st,'frames':nn,'peak_dBFS':db(np.abs(xx).max()),'deterministic_dBFS':db(np.abs(ya-yb).max())}
    R['chain']['presets']=pres; await pg.select_option('#chPreset','Clean Pop')
    R['chain']['pass']=full['preset']=='Clean Pop' and full['on'] and R['chain']['null_all_stages_bypassed_vs_dry_dBFS']<=-120 and R['chain']['null_chain_off_vs_dry_dBFS']<=-120 and R['chain']['repeat_render_maxdiff_dBFS']<=-120 and R['chain']['chain_vs_dry_rms_diff_dBFS']>-60 \
      and all(v['frames']==EXP and v['peak_dBFS']<=-1.0 and v['deterministic_dBFS']<=-120 and (v['state']['p']==k or k=='Off') for k,v in pres.items()) and not pres['Off']['state']['on']
    # ---- guide vocal
    before=await pg.evaluate(f"()=>{{const f={F},sc=f.scoresFor('voice'); return f.takes().map(t=>sc.segs.map(s=>s.cells[t.id].reason))}}")
    await pg.set_input_files('#gdFile',FX+'/guide-92bpm-Am-pad300.wav'); await pg.wait_for_function(f"{P}.hasGuide()")
    after=await pg.evaluate(f"()=>{{const f={F},sc=f.scoresFor('voice'); return f.takes().map(t=>sc.segs.map(s=>s.cells[t.id].score+' '+s.cells[t.id].reason))}}")
    gl=await pg.evaluate(f"()=>{{const d={P}.guideLoop(48000); let s=0; for(let i=0;i<d.length;i++) s+=d[i]*d[i]; return {{len:d.length, rms:Math.sqrt(s/d.length)}}}}")
    _,_,mg=await wav(pg,{'gain':0.5}); _,_,mng=await wav(pg,{'gain':0.5,'only':['band','voice','backing']}); _,_,mgg=await wav(pg,{'gain':0.5,'only':['band','voice','backing','guide']}); await pg.evaluate(f"()=>{{ {F}.state.guide.score=true }}")
    R['guide']={'score_default_on':await pg.evaluate(f"()=>{F}.state.guide.score"),'rec_only_default':await pg.evaluate(f"()=>{F}.state.guide.recOnly"),'loop_len':gl['len'],'loop_rms':round(gl['rms'],4),
      'scores_vs_key_take1':before[0],'scores_vs_guide_take1':after[0],'mix_excludes_guide_maxdiff_dBFS':db(np.abs(mg-mng).max()),'guide_forced_in_differs_dBFS':db(np.abs(mgg-mng).max())}
    R['guide']['pass']=all(int(x.split()[0])>=95 for x in after[0]) and R['guide']['score_default_on'] and R['guide']['rec_only_default'] and gl['len']==EXP and gl['rms']>0.01 and np.abs(mg-mng).max()<1e-6 and np.abs(mgg-mng).max()>1e-3
    # ---- stems ZIP (unlock flipped in memory for the test only)
    await pg.check('#gdStem'); await pg.evaluate(f"()=>{{ {F}.lic.valid=true }}")
    z=await pg.evaluate(f"async()=>{{const r=await {F}.exportStemsBytes(); return {{name:r.name,b64:window.__qa.b64(r.zip)}}}}"); await pg.evaluate(f"()=>{{ {F}.lic.valid=false }}"); await pg.uncheck('#gdStem')
    zb=base64.b64decode(z['b64']); open(OD+'/'+z['name'],'wb').write(zb); zf=zipfile.ZipFile(io.BytesIO(zb)); names=zf.namelist(); fr={nn:load(zf.read(nn))[1] for nn in names if nn.endswith('.wav')}
    R['stems']={'files':names,'frames':sorted(set(fr.values())),'pass':set(fr.values())=={EXP} and any('-backing-' in x for x in names) and any('vocal-comp-chain' in x for x in names) and any('vocal-comp-dry' in x for x in names) and sum('raw-' in x for x in names)==4 and any('-guide-' in x for x in names)}
    # ---- lyrics
    await pg.fill('#lyrText',LYR); await pg.click('#lyrAuto')
    ly=await pg.evaluate(f"()=>{{const s={F}.state.lyr, fr={P}.guideAn(); let st=[],v0=null; for(let i=0;i<fr.t.length;i++){{const v=fr.rms[i]>0.006&&fr.f0[i]>0; if(v&&v0==null) v0=fr.t[i]; if(!v&&v0!=null){{st.push(v0); v0=null;}}}} return {{text:s.text, times:s.times, words:s.words, ons:fr.on.concat(st)}}}}")
    L=LYR.split('\n'); timed=[i for i,l in enumerate(L) if l.strip() and not re.match(r'^\s*[\[(].*[\])]\s*$',l)]; ts=[ly['times'][str(i)] for i in timed]
    near=[min(abs(t-o) for o in ly['ons']) for t in ts]; wmono=all(all(b>a for a,b in zip(ly['words'][str(i)],ly['words'][str(i)][1:])) for i in timed)
    R['lyrics']={'text_identical':ly['text']==LYR,'line_times_s':ts,'monotonic':all(b>a for a,b in zip(ts,ts[1:])),'words_monotonic':wmono,'max_dist_to_guide_onset_ms':round(max(near)*1000,1),'bar_starts_s':[round(k*4*60/92,3) for k in range(8)]}
    await pg.click(f'#lyrList [data-i="{timed[2]}"][data-n="0.05"]'); await pg.check(f'#lyrList [data-lock="{timed[2]}"]'); edited=await pg.evaluate(f"()=>JSON.stringify({F}.state.lyr)")
    lrc=await pg.evaluate(f"()=>{P}.lrc()"); open(OD+'/lyrics.lrc','w').write(lrc)
    lr=[l for l in lrc.strip().split('\n') if re.match(r'^\[\d\d:\d\d\.\d\d\]',l)]; lt=[int(l[1:3])*60+float(l[4:9]) for l in lr]
    R['lrc']={'lines':len(lr),'all_tagged_lines_valid':all(re.match(r'^\[\d\d:\d\d\.\d\d\].+$',l) for l in lr),'headers_valid':all(re.match(r'^\[[a-z]+:.*\]$',l) for l in lrc.strip().split('\n') if not re.match(r'^\[\d',l)),'monotonic':all(b>=a for a,b in zip(lt,lt[1:])),'text_matches':[l[10:] for l in lr]==[L[i] for i in timed]}
    R['lrc']['pass']=all(R['lrc'][k] for k in ['all_tagged_lines_valid','headers_valid','monotonic','text_matches']) and len(lr)==len(timed)
    mb=await pg.evaluate(f"()=>window.__qa.b64({F}.exportMidBytes().bytes)"); open(OD+'/lyrics-test.mid','wb').write(base64.b64decode(mb)); mf=mido.MidiFile(OD+'/lyrics-test.mid')
    ml=[e.text for t in mf.tracks for e in t if e.type=='lyrics']; mm=[e.text for t in mf.tracks if t.name=='Lyrics' for e in t if e.type=='marker']
    R['lrc']['midi_lyric_events']=len(ml); R['lrc']['midi_line_markers']=len(mm); R['lrc']['pass']&= ml==[w for i in timed for w in L[i].split()] and len(mm)==len(timed)
    # ---- reload persistence (backing file + settings + guide + lyrics edits)
    pre=await pg.evaluate(f"()=>({{bk:{F}.state.bk, src:{F}.state.src, chain:{F}.state.chain.preset}})")
    await pg.reload(); await pg.wait_for_function(f"window.__pro && {P}.ready"); await pg.evaluate(f"()=>{P}.ready"); await pg.wait_for_timeout(500)
    post=await pg.evaluate(f"()=>({{bk:{F}.state.bk, src:{F}.state.src, chain:{F}.state.chain.preset, isBk:{P}.isBk(), guide:{P}.hasGuide(), lyr:JSON.stringify({F}.state.lyr), ta:document.getElementById('lyrText').value, name:document.getElementById('bkName').textContent}})")
    R['persist']={'backing_file_restored':post['isBk'],'guide_restored':post['guide'],'settings_equal':pre['bk']==post['bk'] and pre['src']==post['src'] and pre['chain']==post['chain'],'offset_ms':post['bk']['offsetMs'],'lyric_edits_equal':post['lyr']==edited,'textarea_byte_identical':post['ta']==LYR,'bk_label':post['name']}
    R['persist']['pass']=all(R['persist'][k] for k in ['backing_file_restored','guide_restored','settings_equal','lyric_edits_equal','textarea_byte_identical']) and post['bk']['offsetMs']==300
    R['lyrics']['pass']=R['lyrics']['text_identical'] and R['lyrics']['monotonic'] and wmono and max(near)<=0.15 and R['persist']['lyric_edits_equal'] and R['persist']['textarea_byte_identical']
    await boot(pg); await pg.evaluate(f"()=>{F}.setSetting('chords','Am F C G')"); await pg.click('#play'); await pg.wait_for_timeout(4000)
    await pg.screenshot(path=OD+'/pro-desktop-full.png',full_page=True); el=await pg.query_selector('section.backing'); await el.screenshot(path=OD+'/pro-backing-guide.png')
    await (await pg.query_selector('section.chain')).screenshot(path=OD+'/pro-chain.png'); await (await pg.query_selector('section.lyrics')).screenshot(path=OD+'/pro-lyrics.png'); await pg.click('#play')
    # ---- clear button
    pg.once('dialog',lambda d: asyncio.ensure_future(d.accept())); await pg.click('#bkClear'); await pg.wait_for_timeout(300)
    R['clear']={'src':await pg.evaluate(f"()=>{F}.state.src"),'isBk':await pg.evaluate(f"()=>{P}.isBk()")}; await pg.reload(); await pg.wait_for_timeout(1200); R['clear']['after_reload']=await pg.evaluate(f"()=>{P}.isBk()"); R['clear']['pass']=R['clear']['src']=='band' and not R['clear']['isBk'] and not R['clear']['after_reload']
    R['errors']=errs; await ctx.close()
    # ---- mobile
    mob={}
    for dev in ['iPhone 13','Pixel 7']:
      d=p.devices[dev]; mc=await br.new_context(**{k:v for k,v in d.items() if k!='default_browser_type'}); mp=await mc.new_page(); me=[]; mp.on('pageerror',lambda e:me.append(str(e)))
      await mp.goto(URL); await mp.tap('#tapBtn'); await mp.wait_for_function(f"{F}.ready()",timeout=90000); await mp.select_option('#src','backing'); await mp.set_input_files('#bkFile',FX+'/backing-92bpm-Am-pad300.wav'); await mp.wait_for_function(f"{P}.isBk()")
      await mp.fill('#lyrText',LYR); ov=await mp.evaluate("()=>({scrollW:document.documentElement.scrollWidth,innerW:innerWidth})"); fn=OD+f"/pro-{dev.replace(' ','-')}.png"
      await (await mp.query_selector('section.backing')).screenshot(path=fn); await mp.screenshot(path=fn.replace('.png','-full.png'),full_page=True)
      mob[dev]={**ov,'errors':me,'pass':ov['scrollW']<=ov['innerW'] and not me}; await mc.close()
    R['mobile']=mob; R['mobile']['pass']=all(v['pass'] for v in mob.values() if isinstance(v,dict))
    await br.close()
  R['summary']={k:bool(v.get('pass')) for k,v in R.items() if isinstance(v,dict) and 'pass' in v}; R['summary']['no_page_errors']=not R['errors']
  json.dump(R,open(OUT,'w'),indent=1,default=str); print(json.dumps(R['summary'],indent=1,default=str))
asyncio.run(main())
