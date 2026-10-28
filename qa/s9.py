# TakeKit AUDIO-ENGINE-RULES section 9 acceptance run (+ product checks). Usage: python3 s9.py <url> [out.json]
import asyncio, base64, json, sys, re, io, wave, os, zipfile, numpy as np, mido
from playwright.async_api import async_playwright
URL=sys.argv[1]; OUT=sys.argv[2] if len(sys.argv)>2 else 's9.json'; OD=os.path.join(os.path.dirname(os.path.abspath(OUT)),'out'); os.makedirs(OD,exist_ok=True)
QD=os.path.dirname(os.path.abspath(__file__)); F="window.__takekit"
HELP="""()=>{ const f=window.__takekit; const b64=b=>{let s=''; for(let i=0;i<b.length;i+=32768) s+=String.fromCharCode.apply(null,b.subarray(i,i+32768)); return btoa(s);};
 window.__qa={ b64, wav: async o=>{ const r=await f.exportWavBytes(o||{}); return {name:r.name,b64:b64(r.bytes),frames:r.frames,gain:r.gain}; },
  mid: ()=>{ const r=f.exportMidBytes(); return {name:r.name,b64:b64(r.bytes)}; } }; }"""
MOCK="""(()=>{ const sent=[]; window.__midiSent=sent; const inp={id:'in1',name:'Mock Keys 49',type:'input',state:'connected',onmidimessage:null}; const out={id:'out1',name:'Mock Synth Out',type:'output',state:'connected',send:(d,t)=>sent.push({d:[...d],t})};
 const acc={inputs:new Map([['in1',inp]]),outputs:new Map([['out1',out]]),onstatechange:null}; window.__mockIn=inp; navigator.requestMIDIAccess=()=>Promise.resolve(acc); })();"""
ARGS=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+QD+'/demo-takes-92bpm-Am.wav']
FLAWS={'demo p1':{1:'+45c sharp',4:'+45c sharp'},'demo p2':{2:'120 ms late',6:'missing'},'demo p3':{0:'-14 dB',5:'-14 dB'},'demo p4':{3:'-50c flat',7:'clipped'}}
def load(b):
  w=wave.open(io.BytesIO(b)); n=w.getnframes(); raw=np.frombuffer(w.readframes(n),dtype=np.uint8).reshape(-1,3)
  v=(raw[:,0].astype(np.int32)|(raw[:,1].astype(np.int32)<<8)|(raw[:,2].astype(np.int32)<<16)); v[v>=1<<23]-=1<<24
  return w.getframerate(),w.getsampwidth(),n,(v/8388607.0).reshape(-1,w.getnchannels()),w.getnchannels()
async def wav(pg,o=None):
  r=await pg.evaluate("o=>window.__qa.wav(o)",o or {}); return r['name'],base64.b64decode(r['b64'])
def midinfo(fn):
  mf=mido.MidiFile(fn); t0=mf.tracks[0]
  return {'type':mf.type,'tracks':[t.name for t in mf.tracks],'tempo_bpm':round(mido.tempo2bpm([e for e in t0 if e.type=='set_tempo'][0].tempo),3),'timesig':[f"{e.numerator}/{e.denominator}" for e in t0 if e.type=='time_signature'],
    'markers':[e.text for t in mf.tracks for e in t if e.type=='marker'],'length_s':round(mf.length,4),'notes_per_track':[sum(1 for e in t if e.type=='note_on' and e.velocity>0) for t in mf.tracks],
    'channels':sorted({e.channel+1 for t in mf.tracks for e in t if e.type=='note_on'})}
async def boot(pg):
  await pg.click('#tapBtn'); await pg.wait_for_function("document.getElementById('tap').classList.contains('hide')"); await pg.evaluate(HELP)
  await pg.wait_for_function(f"{F}.ready()",timeout=90000)
async def setv(pg,k,v): return await pg.evaluate(f"([k,v])=>{F}.setSetting(k,v)",[k,v])
rms=lambda a: float(np.sqrt((np.asarray(a,dtype=np.float64)**2).mean()))
async def main():
  res={}
  async with async_playwright() as p:
    br=await p.chromium.launch(args=ARGS)
    ctx=await br.new_context(viewport={'width':1360,'height':1000},accept_downloads=True); await ctx.add_init_script(MOCK); pg=await ctx.new_page(); errs=[]; reqs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console',lambda m: m.type=='error' and errs.append(m.text)); pg.on('request',lambda r: reqs.append(r.url))
    await pg.goto(URL); await pg.evaluate("()=>{localStorage.clear(); indexedDB.deleteDatabase('takekit')}"); await pg.reload(); await pg.screenshot(path=OD+'/shot-tap.png')
    await boot(pg)
    res['live_ctx']=await pg.evaluate(f"()=>({{sampleRate:{F}.ctx().sampleRate,state:{F}.ctx().state,load:document.getElementById('load').textContent,mic:document.getElementById('micState').textContent}})")
    # ---- import the demo takes (4 passes of a sampled voice with known flaws) and check the auto comp
    b64=base64.b64encode(open(QD+'/demo-takes-92bpm-Am.wav','rb').read()).decode()
    await pg.evaluate("async b=>await window.__takekit.importBytes(b,'demo.wav')",b64)
    cp=await pg.evaluate(f"""()=>{{const f={F}, sc=f.scoresFor('voice'), c=f.comps(), nm=id=>(f.takes().find(t=>t.id===id)||{{}}).name||null; return {{takes:f.takes().map(t=>t.name), comp:c.voice.choice.map(nm), why:c.voice.why, best_whole_take:nm(c.bestVoice),
      grid:Object.fromEntries(f.takes().map(t=>[t.name, sc.segs.map(s=>s.cells[t.id].score+' '+s.cells[t.id].reason)]))}}}}""")
    picked_flaws=[(k,cp['comp'][k]) for k in range(8) if k in FLAWS.get(cp['comp'][k],{})]
    flagged={nm:{k:cp['grid'][nm][k] for k in fl} for nm,fl in FLAWS.items()}
    cp['planted_flaws']=FLAWS; cp['flawed_cells_as_scored']=flagged; cp['comp_picked_flawed_cells']=picked_flaws
    cp['pass']=len(cp['takes'])==4 and not picked_flaws and all('clean' not in v for d in flagged.values() for v in d.values()); res['comp']=cp
    # ---- c1 exact length, downbeat at 0, peak
    name,b=await wav(pg); open(OD+'/'+name,'wb').write(b); sr,sw,n,x,nc=load(b); m=np.abs(x).max(1); pk=np.abs(x).max(); exp=round(8*4*60/92*48000); fi=int(np.argmax(m>0.01*pk))
    _,bk=await wav(pg,{'only':['drums']}); xk1=load(bk)[3]; mk=np.abs(xk1).max(1); fk=int(np.argmax(mk>0.05*mk.max()))
    _,bv=await wav(pg,{'only':['voice']}); xv=load(bv)[3]
    res['c1']={'file':name,'sr':sr,'bits':sw*8,'ch':nc,'frames':n,'expected':exp,'peak_dBFS':round(20*np.log10(pk),3),'first_sample_over_1pct_peak':fi,'first_transient_ms':round(fi/48,3),
      'drums_only_first_onset_5pct_ms':round(fk/48,3),'level_first_1ms_dBFS':round(20*np.log10(np.abs(x[:48]).max()+1e-12),2),'vocal_comp_in_mix_rms_dBFS':round(20*np.log10(rms(xv)+1e-12),1)}
    res['c1']['pass']=n==exp==1001739 and sr==48000 and sw==3 and nc==2 and res['c1']['peak_dBFS']<=-1.0 and fi/48<=1.0 and fk/48<=1.0 and rms(xv)>1e-3
    other={}
    for bpm,bars in [(60,4),(137,8),(180,16)]:
      await setv(pg,'bpm',bpm); await setv(pg,'bars',bars); _,bb=await wav(pg); s=load(bb); other[f'{bpm}bpm_{bars}bars']={'frames':s[2],'expected':round(bars*4*60/bpm*48000),'peak_dBFS':round(20*np.log10(np.abs(s[3]).max()),3)}
    await setv(pg,'bpm',92); await setv(pg,'bars',8)
    res['c1_other_lengths']=other; res['c1_other_pass']=all(v['frames']==v['expected'] and v['peak_dBFS']<=-1 for v in other.values())
    # ---- c2 4x loop: drift, seam, tail fold == continuous playback
    x2=load((await wav(pg))[1])[3]; t=np.tile(x,(4,1)); N=len(x); bar=48000*4*60/92; xk=np.tile(xk1[:,0],4); pkk=np.abs(xk).max(); dev=[]
    for k in range(32):
      e=int(round(k*bar)); w=np.abs(xk[max(0,e-200):e+200]); dev.append(int(np.argmax(w>0.05*pkk))+max(0,e-200)-e)
    a8=load((await wav(pg,{'only':['drums','bass'],'gain':0.25}))[1])[3]; await setv(pg,'bars',16); a16=load((await wav(pg,{'only':['drums','bass'],'gain':0.25}))[1])[3]; await setv(pg,'bars',8)
    pk8=np.abs(a8).max(); dd=np.abs(a16[N:2*N]-a8); near=np.abs(a16[N-480:N+480]-np.vstack([a8[-480:],a8[:480]]))
    d=np.abs(np.diff(t[:,0])); typ=float(np.percentile(d,99.99)); sp=max(max(dev[i::4])-min(dev[i::4]) for i in range(4)); tr=float(np.polyfit(range(32),dev,1)[0]*32)
    res['c2']={'total_frames_4x':len(t),'expected_4x':4*exp,'drift_samples':len(t)-4*exp,'kick_downbeat_onsets_32bars_samples':sorted(set(dev)),'onset_spread_same_bar_position':sp,'onset_trend_samples_over_32_bars':round(tr,3),
      'tail_fold_vs_continuous_16bar_render':{'maxdiff_rel':float(dd.max()/pk8),'maxdiff_within_10ms_of_seam_rel':float(near.max()/pk8),'parts':'drums+bass (no voice-leading memory)','note':'away from the seam the 16-bar render differs only by 1-sample rounding of fractional step times (a bar is 125217.39 samples); the seam region itself matches'},
      'seam_abs_sample_step':[round(float(d[k*N-1]),5) for k in (1,2,3)],'sample_step_p99.99_in_file':round(typ,5)}
    res['c2']['pass']=res['c2']['drift_samples']==0 and sp<=5 and abs(tr)<1 and near.max()/pk8<0.01 and max(res['c2']['seam_abs_sample_step'])<=max(typ,1e-3)
    rd=float(np.abs(x-x2).max()); res['determinism']={'repeat_render_maxdiff':rd,'repeat_render_maxdiff_dBFS':round(20*np.log10(rd+1e-12),1),'pass':rd<=10**(-120/20)}
    # ---- c6 longest held note at the slowest preset tempo: Ballad 68 BPM, strings held a full bar
    await setv(pg,'recipe','ballad'); await setv(pg,'bpm',68); await pg.wait_for_function(f"{F}.ready()",timeout=90000)
    s6=load((await wav(pg,{'only':['pad']}))[1])[3].mean(1); bn=int(round(48000*4*60/68)); seg=s6[bn:2*bn]; mid=rms(seg[int(bn*.3):int(bn*.5)]); end=rms(seg[int(bn*.92):int(bn*.99)])
    res['c6']={'recipe':'ballad','bpm':68,'note_s':round(4*60/68,3),'instrument':'String ensemble (FluidR3), looped sustain','rms_30-50%':round(mid,4),'rms_92-99%':round(end,4),'end/mid':round(end/mid,3)}
    res['c6']['pass']=end/mid>0.8; await setv(pg,'recipe','pop'); await setv(pg,'bpm',92)
    # ---- c4 live changes while playing: heard within one bar, no restart; MIDI out mirrors the band
    await pg.evaluate("()=>{const s=document.getElementById('midiOut'); s.value='out1'; s.dispatchEvent(new Event('change'))}")
    await pg.click('#play'); await pg.wait_for_timeout(3000); live={}
    p1=await pg.evaluate(f"()=>{F}.takes().find(t=>t.name==='demo p1').id"); seg0_before=cp['comp'][0]
    acts=[('lock_bar1_to_p1',f"()=>{F}.lock('voice',0,'{p1}')",lambda e,v:e['ver']>v and e['voice'] and e['voice'].split('|')[0]==str(e['ver']),92),
          ('ab_switch_to_A_best_take',"()=>document.getElementById('abA').click()",lambda e,v:e['listen']=='best' and e['voice'] and '|best|' in e['voice'],92),
          ('mute_drums',"()=>document.querySelector('[data-m=drums]').click()",lambda e,v:e['step']%2==0 and e['ver']>v and not any(n.startswith('drums:') for n in e['notes']),92),
          ('recipe_groove',"()=>{const e=document.getElementById('recipe');e.value='groove';e.dispatchEvent(new Event('change'))}",lambda e,v:e['recipe']=='groove' and any(n.startswith('keys:') for n in e['notes']),92),
          ('key_D',"()=>{const e=document.getElementById('key');e.value='2';e.dispatchEvent(new Event('change'))}",lambda e,v:e['keyRoot']==2,92),
          ('bpm_120',"()=>{const e=document.getElementById('bpm');e.value=120;e.dispatchEvent(new Event('change'))}",lambda e,v:e['bpm']==120,92)]
    for nm,act,ok,bpm0 in acts:
      t0=await pg.evaluate(f"()=>{F}.ctx().currentTime"); v=await pg.evaluate("()=>Math.max(...window.__schedLog.map(e=>e.ver))"); await pg.evaluate(act); await pg.wait_for_timeout(3000); log=await pg.evaluate("()=>window.__schedLog")
      hit=[e for e in log if e['time']>t0 and ok(e,v)]; barS=4*60/bpm0
      live[nm]={'heard_at_s_after_change':round(hit[0]['time']-t0,3) if hit else None,'one_bar_s':round(barS,3),'pass':bool(hit) and hit[0]['time']-t0<=barS}
      if nm.startswith('lock'): live['lock_effect']={'bar1_before':seg0_before,'bar1_after':await pg.evaluate(f"()=>{{const f={F}; const id=f.comps().voice.choice[0]; return (f.takes().find(t=>t.id===id)||{{}}).name}}")}
    live['still_playing_no_restart']=await pg.evaluate(f"()=>{F}.playing()"); res['c4']=live
    res['c4']['pass']=all(v['pass'] for v in live.values() if isinstance(v,dict) and 'pass' in v) and live['still_playing_no_restart'] and live['lock_effect']['bar1_after']=='demo p1'
    res['midi_out']={'msgs_sent_while_playing':await pg.evaluate("()=>window.__midiSent.length"),'channels':sorted(await pg.evaluate("()=>[...new Set(window.__midiSent.filter(m=>(m.d[0]&0xF0)==0x90).map(m=>(m.d[0]&15)+1))]"))}
    res['midi_out']['pass']=res['midi_out']['msgs_sent_while_playing']>20 and 10 in res['midi_out']['channels'] and len(res['midi_out']['channels'])>=3
    await pg.wait_for_timeout(500); res['stop']=await pg.evaluate(f"()=>{F}.measureStopSilence()")
    res['stop']['active_after']=await pg.evaluate(f"()=>{F}.active()"); res['stop']['all_notes_off_channels']=await pg.evaluate("()=>new Set(window.__midiSent.filter(m=>(m.d[0]&0xF0)==0xB0&&m.d[1]==123).map(m=>m.d[0]&15)).size")
    res['stop']['pass']=res['stop']['ms'] is not None and res['stop']['ms']<=50 and res['stop']['all_notes_off_channels']==16 and res['stop']['active_after']==0
    await pg.click('[data-m=drums]'); await setv(pg,'recipe','pop'); await setv(pg,'keyRoot',9); await setv(pg,'bpm',92); await pg.evaluate(f"()=>{{delete {F}.state.locks.voice[0];}}"); await setv(pg,"listen","comp")
    # ---- c3 hidden tab 30 s while recording
    n_takes0=await pg.evaluate(f"()=>{F}.takes().length+{F}.midiTakes().length")
    await pg.click('#rec'); await pg.wait_for_timeout(1500)
    oth=await ctx.new_page(); await oth.goto('about:blank'); await oth.bring_to_front()
    n0=await pg.evaluate("()=>{Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'));return window.__schedLog.length}")
    await pg.wait_for_timeout(30000); await pg.bring_to_front()
    await pg.evaluate("()=>{Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'))}"); await pg.wait_for_timeout(1500)
    res['c3']={'hidden_s':30,'was_recording':True,'playing_on_return':await pg.evaluate(f"()=>{F}.playing()"),'recording_on_return':await pg.evaluate(f"()=>{F}.recording()"),'steps_scheduled_while_hidden_and_after':await pg.evaluate("()=>window.__schedLog.length")-n0,
      'active_voices_after':await pg.evaluate(f"()=>{F}.active()"),'takes_added_by_partial_pass':await pg.evaluate(f"()=>{F}.takes().length+{F}.midiTakes().length")-n_takes0,'status':await pg.text_content('#status')}
    res['c3']['pass']=not res['c3']['playing_on_return'] and not res['c3']['recording_on_return'] and res['c3']['steps_scheduled_while_hidden_and_after']==0 and res['c3']['active_voices_after']==0 and res['c3']['takes_added_by_partial_pass']==0; await oth.close()
    # ---- live recording: fake mic + mock MIDI keyboard, 4 bars at 180 BPM, two full passes -> audio takes + MIDI takes
    await pg.evaluate("()=>{const sel=document.getElementById('midiIn'); sel.value='in1'; sel.dispatchEvent(new Event('change'))}")
    await setv(pg,'bpm',180); await setv(pg,'bars',4); nv0=await pg.evaluate(f"()=>{F}.takes().length"); nm0=await pg.evaluate(f"()=>{F}.midiTakes().length")
    await pg.click('#rec'); await pg.evaluate("""()=>{ const I=window.__mockIn, sc=[57,60,64,67,69,72]; let i=0; window.__feed=setInterval(()=>{ const n=sc[i++%sc.length]; I.onmidimessage({data:new Uint8Array([0x90,n,60+(i%5)*12])}); setTimeout(()=>I.onmidimessage({data:new Uint8Array([0x80,n,0])}),150); },333); }""")
    await pg.wait_for_timeout(11900); await pg.evaluate("()=>clearInterval(window.__feed)"); await pg.click('#play'); await pg.wait_for_timeout(500)
    rc=await pg.evaluate(f"""()=>{{const f={F}; return {{voice_takes:f.takes().slice({nv0}).map(t=>({{name:t.name,sr:t.sr,secs:+(t.data.length/t.sr).toFixed(3),bpm:t.bpm,bars:t.bars}})), midi_takes:f.midiTakes().slice({nm0}).map(t=>({{name:t.name,notes:t.notes.length,vels:[...new Set(t.notes.map(n=>Math.round(n.v*127)))].sort((a,b)=>a-b)}})), status:document.getElementById('status').textContent, latency_s:f.latencyS()}}}}""")
    rc['loop_s']=round(4*4*60/180,3); rc['pass']=len(rc['voice_takes'])>=1 and len(rc['midi_takes'])>=1 and all(abs(t['secs']-rc['loop_s'])<0.01 for t in rc['voice_takes']) and all(t['notes']>=10 for t in rc['midi_takes'])
    await pg.evaluate(f"()=>{F}.paintTakes()"); await pg.click('#laneM'); await pg.screenshot(path=OD+'/shot-midi-lane.png',full_page=True); await pg.click('#laneV')
    mm=await pg.evaluate("()=>window.__qa.mid()"); fn=OD+'/'+mm['name']; open(fn,'wb').write(base64.b64decode(mm['b64'])); mi=midinfo(fn); mi['file']=mm['name']; mi['expected_s']=round(4*4*60/180,4)
    mi['pass']=mi['type']==1 and mi['tempo_bpm']==180 and mi['timesig'][:1]==['4/4'] and abs(mi['length_s']-mi['expected_s'])<0.01 and sum(1 for t in mi['tracks'] if t.startswith('MIDI '))==len(rc['midi_takes'])+nm0 and len(mi['markers'])>=4 and 10 in mi['channels']
    res['recording']=rc; res['midi_file']=mi
    await setv(pg,'bpm',92); await setv(pg,'bars',8)
    # ---- MIDI in: velocity, sustain, never starts the transport
    mi2=await pg.evaluate("""async()=>{const f=window.__takekit, I=window.__mockIn, snd=d=>I.onmidimessage({data:new Uint8Array(d)}); window.__liveLog.length=0;
      snd([0x90,52,30]); snd([0x80,52,0]); snd([0x90,67,120]); snd([0x80,67,0]); await new Promise(r=>setTimeout(r,60)); const afterOffNoPedal=f.liveVoices();
      snd([0x90,64,100]); snd([0xB0,64,127]); snd([0x80,64,0]); await new Promise(r=>setTimeout(r,300)); const heldAfterOff=f.liveVoices(), sus=f.sustainOn(); snd([0xB0,64,0]); await new Promise(r=>setTimeout(r,100)); snd([0xFA]); snd([0xF8]);
      return {vels:window.__liveLog.map(e=>[e.note,Math.round(e.vel*127)]), voices_after_noteoff_no_pedal:afterOffNoPedal, held_after_noteoff_with_pedal:heldAfterOff, sustain_flag:sus, after_pedal_up:f.liveVoices(), playing_after_notes_and_0xFA:f.playing(),
        inputs:[...document.getElementById('midiIn').options].map(o=>o.text), outputs:[...document.getElementById('midiOut').options].map(o=>o.text), note:document.getElementById('midiNote').textContent}}""")
    mi2['pass']=mi2['vels']==[[52,30],[67,120],[64,100]] and mi2['voices_after_noteoff_no_pedal']==0 and mi2['held_after_noteoff_with_pedal']==1 and mi2['sustain_flag'] and mi2['after_pedal_up']==0 and not mi2['playing_after_notes_and_0xFA']
    res['midi_in']=mi2
    await pg.mouse.click(5,5); await pg.keyboard.press('a'); await pg.keyboard.press('j'); await pg.click('.kbd .wk >> nth=2')
    res['keys']={'log':await pg.evaluate("()=>window.__liveLog.slice(-3).map(e=>[e.note,e.src])"),'playing_after':await pg.evaluate(f"()=>{F}.playing()")}
    res['keys']['pass']=len(res['keys']['log'])==3 and not res['keys']['playing_after']
    # ---- A/B at matched loudness (best whole take vs comp)
    bid=await pg.evaluate(f"()=>{F}.comps().bestVoice"); mk_=await pg.evaluate(f"(id)=>{F}.makeupFor(id)",bid)
    ra=rms(load((await wav(pg,{'only':['voice'],'listen':bid,'gain':0.5}))[1])[3]); rb=rms(load((await wav(pg,{'only':['voice'],'gain':0.5}))[1])[3])
    res['ab']={'A':'best whole take','B':'comp','makeup_gain_A':round(mk_,4),'A_rms_dB_raw':round(20*np.log10(ra),2),'B_rms_dB':round(20*np.log10(rb),2),'A_after_makeup_minus_B_dB':round(20*np.log10(ra*mk_/rb),3)}
    res['ab']['pass']=abs(res['ab']['A_after_makeup_minus_B_dB'])<0.5
    # ---- audio I/O, mic monitor + gate defaults
    res['audio_io']={'inputs':await pg.evaluate("()=>[...document.getElementById('audioIn').options].map(o=>o.text)"),'outputs':await pg.evaluate("()=>[...document.getElementById('audioOut').options].map(o=>o.text)"),
      'setSinkId_supported':await pg.evaluate("()=>typeof AudioContext.prototype.setSinkId==='function'"),'mic_state':await pg.text_content('#micState'),
      'monitor_default_on':await pg.is_checked('#monitor'),'gate_default_on':await pg.is_checked('#gateOn'),'gate_controls':await pg.evaluate("()=>['g_th','g_atk','g_hold','g_rel'].map(i=>[i,document.getElementById(i).value])"),
      'meter_max_pct_3s':await pg.evaluate("async()=>{let m=0; for(let i=0;i<30;i++){ m=Math.max(m,parseFloat(document.getElementById('meterBar').style.width)||0); await new Promise(r=>setTimeout(r,100)); } return m;}")}
    await pg.evaluate("()=>{const s=document.getElementById('audioOut'); if(s.options.length>1){ s.value=s.options[1].value; s.dispatchEvent(new Event('change')); }}"); await pg.wait_for_timeout(500)
    res['audio_io']['sink_after_select']=await pg.evaluate(f"()=>{F}.ctx().sinkId"); res['audio_io']['out_note']=await pg.text_content('#audioOutNote')
    res['audio_io']['pass']=len(res['audio_io']['inputs'])>=1 and res['audio_io']['meter_max_pct_3s']>0 and res['audio_io']['monitor_default_on'] and res['audio_io']['gate_default_on'] and 'Mic on' in res['audio_io']['mic_state']
    # ---- stems ZIP (unlock simulated in the test only: lic.valid flipped in memory, never saved)
    await pg.evaluate(f"()=>{{ {F}.lic.valid=true; }}")
    z=await pg.evaluate(f"async()=>{{const r=await {F}.exportStemsBytes(); return {{name:r.name,b64:window.__qa.b64(r.zip)}}}}"); await pg.evaluate(f"()=>{{ {F}.lic.valid=false; }}")
    zb=base64.b64decode(z['b64']); open(OD+'/'+z['name'],'wb').write(zb); zf=zipfile.ZipFile(io.BytesIO(zb)); names=zf.namelist(); fr={nn:load(zf.read(nn))[2] for nn in names if nn.endswith('.wav')}
    res['stems']={'zip':z['name'],'files':names,'wav_frames':sorted(set(fr.values())),'pass':len(set(fr.values()))==1 and list(fr.values())[0]==exp and sum('raw-' in nn for nn in names)==4 and any('vocal-comp' in nn for nn in names) and any(nn.endswith('.mid') for nn in names)}
    # ---- persistence (settings in localStorage, takes in IndexedDB)
    await pg.fill('#chords','Am C G F'); await pg.press('#chords','Tab'); await pg.fill('#bpm','92'); await pg.press('#bpm','Tab'); await pg.evaluate(f"()=>{F}.lock('voice',2,{F}.takes()[1].id)")
    before=await pg.evaluate(f"()=>JSON.stringify({F}.state)"); nt=await pg.evaluate(f"()=>{F}.takes().length")
    await pg.reload(); await pg.wait_for_timeout(1500); after=await pg.evaluate(f"()=>JSON.stringify({F}.state)")
    res['persist']={'settings_equal_after_reload':before==after,'audio_takes_before':nt,'audio_takes_after':await pg.evaluate(f"()=>{F}.takes().length"),'sample':await pg.evaluate(f"()=>({{bpm:document.getElementById('bpm').value,chords:document.getElementById('chords').value,key:document.getElementById('key').value,lock_bar3:{F}.state.locks.voice[2]!=null,midi_takes:{F}.midiTakes().length}})")}
    res['persist']['pass']=res['persist']['settings_equal_after_reload'] and res['persist']['audio_takes_after']==nt and res['persist']['sample']['chords']=='Am C G F' and res['persist']['sample']['lock_bar3']
    await boot(pg); await pg.evaluate(f"()=>{{ delete {F}.state.locks.voice[2]; }}"); await setv(pg,'chords','Am F C G')
    res['license']={'buy':await pg.text_content('#buy'),'config':await pg.evaluate(f"()=>{F}.LEMON")}
    await pg.fill('#licKey','TEST-KEY'); await pg.click('#licBtn'); await pg.wait_for_timeout(300); res['license']['activate_msg']=await pg.text_content('#licState')
    await pg.click('#stems'); await pg.wait_for_timeout(200); res['license']['stems_gate']=await pg.text_content('#status')
    await setv(pg,'bars',16); await pg.click('#wav'); await pg.wait_for_timeout(200); res['license']['16bar_gate']=await pg.text_content('#status'); await setv(pg,'bars',8)
    async with pg.expect_download() as dl: await pg.click('#wav')
    d0=await dl.value; fp=OD+'/'+d0.suggested_filename; await d0.save_as(fp); res['license']['free_download']={'file':d0.suggested_filename,'frames':load(open(fp,'rb').read())[2]}
    async with pg.expect_download() as dl: await pg.click('#mid')
    d1=await dl.value; await d1.save_as(OD+'/'+d1.suggested_filename); res['license']['free_midi']=d1.suggested_filename
    res['license']['pass']='opening soon' in res['license']['buy'].lower() and 'opening soon' in res['license']['activate_msg'].lower() and 'unlock' in res['license']['stems_gate'].lower() and 'unlock' in res['license']['16bar_gate'].lower() and d0.suggested_filename=='takekit-pop-92bpm-Am.wav' and d1.suggested_filename=='takekit-pop-92bpm-Am.mid'
    await pg.click('#play'); await pg.wait_for_timeout(3000); await pg.screenshot(path=OD+'/shot-desk.png',full_page=True); await pg.screenshot(path=OD+'/shot-top.png'); await pg.click('#play')
    host=URL.split('/')[2]; ext=sorted(set(u.split('/')[2] for u in reqs if host not in u and not u.startswith(('data:','blob:'))))
    res['c5']={'external_hosts':ext,'sample_urls_pinned':all(re.search(r'@[0-9a-f]{40}/|/[0-9a-f]{40}/',u) for u in reqs if 'midi-js-soundfonts' in u),'sample_requests':sum(1 for u in reqs if 'midi-js-soundfonts' in u),'bundled_kit_requests':sum(1 for u in reqs if '/samples/drums/' in u)}
    src=await pg.evaluate("()=>fetch('app.js').then(r=>r.text())"); html=await pg.evaluate("()=>fetch('index.html').then(r=>r.text())")
    exp_path=src[src.index('// ---------- export'):src.index('// ---------- Lemon')]
    res['c7']={'@main/@gh-pages':len(re.findall(r'@main|@gh-pages|/main/|/gh-pages/',src+html)),'FluidR3_pinned_sha':re.findall(r'SF_SHA = "([0-9a-f]+)"',src),'Math.random_total':src.count('Math.random'),'Math.random_export_path':exp_path.count('Math.random'),
      'setTimeout_used_for_notes':len(re.findall(r'setTimeout\([^)]*(playEvent|liveOn|scheduleStep|scheduleVoiceBar)',src)),'compressor_in_export_path':exp_path.count('DynamicsCompressor'),'MAX_SHIFT':re.findall(r'MAX_SHIFT = (\d+)',src),
      'LOOKAHEAD_MS=25':'LOOKAHEAD_MS = 25' in src,'SCHEDULE_AHEAD=0.12':'SCHEDULE_AHEAD = 0.12' in src,'auth_or_db':len(re.findall(r'supabase|firebase|firestore|signIn|/api/auth',src+html,re.I)),'ios_silent_note':'silent' in html.lower(),'stop_release_s':re.findall(r'FAST_RELEASE = ([0-9.]+)',src),'note_release_floors_s':re.findall(r'Math\.max\((0\.0[0-9]+), dur',src)}
    vm=await pg.evaluate(f"()=>({{inst:Object.entries({F}.INST).map(([k,v])=>[k,v.dir,v.label]), kit:Object.entries({F}.KIT).map(([k,v])=>[k,v.file,v.label])}})")
    bad=[r for r in vm['inst'] if not any(tok in r[2].lower() for tok in r[1].split('_') if len(tok)>2)]+[r for r in vm['kit'] if not (r[0] in ('kick','snare','rim') and r[0] in r[2].lower() or r[0] in ('ghost','hat','ohat'))]
    used=sorted({u.split('/FluidR3_GM/')[1].split('-mp3')[0] for u in reqs if '/FluidR3_GM/' in u}); res['c7']['voice_name_mismatches']=bad; res['c7']['voices']=vm; res['c7']['fluid_dirs_requested']=used
    res['c7']['requested_dirs_all_declared']=all(any(dd==r[1] for r in vm['inst']) for dd in used)
    res['c7']['pass']=res['c7']['@main/@gh-pages']==0 and len(res['c7']['FluidR3_pinned_sha'][0])==40 and res['c7']['Math.random_total']==0 and res['c7']['setTimeout_used_for_notes']==0 and res['c7']['compressor_in_export_path']==0 and res['c7']['LOOKAHEAD_MS=25'] and res['c7']['SCHEDULE_AHEAD=0.12'] and res['c7']['auth_or_db']==0 and not bad and res['c7']['requested_dirs_all_declared'] and int(res['c7']['MAX_SHIFT'][0])<=4
    res['errors']=errs; await ctx.close()
    # ---- c5 blocked sample host: names the missing instruments
    bc=await br.new_context(viewport={'width':1360,'height':1000}); bp=await bc.new_page(); berr=[]; bp.on('pageerror',lambda e:berr.append(str(e)))
    await bc.route(re.compile(r'.*(cdn\.jsdelivr\.net|raw\.githubusercontent\.com).*'),lambda r: r.abort())
    await bp.goto(URL); await bp.click('#tapBtn'); await bp.wait_for_timeout(8000); ls=await bp.text_content('#load')
    await bp.click('#play'); await bp.wait_for_timeout(1500); stt=await bp.text_content('#status')
    ex=await bp.evaluate(f"async()=>{{try{{await {F}.exportWavBytes(); return 'no error'}}catch(e){{return e.message}}}}"); await bp.screenshot(path=OD+'/shot-blocked.png')
    res['c5']['blocked_host']={'load':ls,'play_status':stt,'export_error':ex,'playing':await bp.evaluate(f"()=>{F}.playing()"),'errors':berr}
    res['c5']['pass']=res['c5']['sample_urls_pinned'] and 'Piano' in ls and 'bass' in ls.lower() and 'Missing instruments' in ex and 'Piano' in stt and not res['c5']['blocked_host']['playing']; await bc.close()
    # ---- mobile
    mob={}
    for dev in ['iPhone 13','Pixel 7']:
      d=p.devices[dev]; mc=await br.new_context(**{k:v for k,v in d.items() if k!='default_browser_type'}); await mc.add_init_script(MOCK); mp=await mc.new_page(); merr=[]; mp.on('pageerror',lambda e:merr.append(str(e)))
      await mp.goto(URL); ios=await mp.evaluate("()=>!document.getElementById('ios').hidden"); await mp.screenshot(path=OD+f"/shot-{dev.replace(' ','-')}-tap.png"); await mp.tap('#tapBtn')
      await mp.wait_for_function(f"{F}.ready()",timeout=90000); await mp.tap('#play'); await mp.wait_for_timeout(1500); steps=await mp.evaluate("()=>window.__schedLog.length")
      ov=await mp.evaluate("()=>({scrollW:document.documentElement.scrollWidth,innerW:innerWidth})"); fn=OD+f"/shot-{dev.replace(' ','-')}.png"; await mp.screenshot(path=fn); await mp.screenshot(path=fn.replace('.png','-full.png'),full_page=True)
      await mp.tap('#play'); mob[dev]={'viewport':d['viewport'],'ios_silent_note_shown':ios,'ctx':await mp.evaluate(f"()=>{F}.ctx().state"),'steps_scheduled_1_5s':steps,'no_horizontal_overflow':ov['scrollW']<=ov['innerW'],**ov,'errors':merr}
      mob[dev]['pass']=mob[dev]['ctx']=='running' and steps>0 and mob[dev]['no_horizontal_overflow'] and not merr and (ios if dev=='iPhone 13' else True)
      await mc.close()
    res['mobile']=mob
    res['summary']={k:v.get('pass') for k,v in res.items() if isinstance(v,dict) and 'pass' in v}
    res['summary']['c1_other_lengths']=res['c1_other_pass']; res['summary']['mobile']=all(v['pass'] for v in mob.values()); res['summary']['no_page_errors']=not errs
    J=lambda o: o.item() if hasattr(o,'item') else str(o); print(json.dumps(res['summary'],indent=1,default=J)); json.dump(res,open(OUT,'w'),indent=1,default=J); await br.close()
if __name__=="__main__": asyncio.run(main())
