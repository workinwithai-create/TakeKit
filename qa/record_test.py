# TakeKit recording acceptance: Chromium (fake mic file) + WebKit iPhone 13 (mock mic). Usage: python3 record_test.py <url> [out.json]
# full pass, live HUD (REC, meter, elapsed bars, growing take), partial stop keeps bars sung ("not sung" after), record from
# current bar, punch-in on a section, dry capture with the gate fully closed, IndexedDB persistence across reload,
# plain errors: permission denied, no input device, AudioContext suspended (tap to resume), unsupported browser.
import asyncio, json, sys, os
from playwright.async_api import async_playwright
URL=sys.argv[1]; OUT=sys.argv[2] if len(sys.argv)>2 else 'record.json'; QD=os.path.dirname(os.path.abspath(__file__)); F="window.__takekit"
ARGS=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+QD+'/demo-takes-92bpm-Am.wav']
async def newpage(p,tag,init=None):
  if tag=='webkit-iphone': br=await p.webkit.launch(); c=await br.new_context(**p.devices['iPhone 13'],permissions=['microphone'])
  else: br=await p.chromium.launch(args=ARGS); c=await br.new_context(viewport={'width':1360,'height':1000},permissions=['microphone'])
  if init: await c.add_init_script(init)
  pg=await c.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.errs=errs; pg.br=br; return pg
async def boot(pg,clear=True):
  await pg.goto(URL)
  if clear: await pg.evaluate("()=>{localStorage.clear(); indexedDB.deleteDatabase('takekit')}"); await pg.reload()
  await pg.click('#tapBtn'); await pg.wait_for_function(f"{F}.ready()",timeout=120000)
async def ev(pg,js): return await pg.evaluate(js)
async def run(p,tag,R):
  ok=lambda k,c,**d: R.__setitem__(tag+':'+k,dict(d,**{'pass':bool(c)}))
  pg=await newpage(p,tag); await boot(pg)
  await pg.wait_for_function(f"!!{F}.mic()",timeout=20000)
  await ev(pg,f"()=>{{{F}.setSetting('bpm',180); const t={F}.state.sections[0]; {F}.setSetting('sections',[Object.assign({{}},t,{{name:'Verse',bars:4,lock:false}}),Object.assign({{}},t,{{name:'Chorus',bars:4,lock:false}})])}}"); await pg.wait_for_timeout(300)
  bd=4*60/180
  # 1 full pass + live HUD while recording
  await ev(pg,f"()=>{F}.seekBar(0)"); await pg.select_option('#recFrom','top'); await pg.click('#rec'); await pg.wait_for_timeout(int(bd*2.6*1000))
  h1=await ev(pg,"()=>({hud:!document.getElementById('recHud').hidden, info:document.getElementById('recInfo').textContent, meter:parseFloat(document.getElementById('recMeter').style.width)||0, grow:parseFloat(document.getElementById('recGrow').style.width)||0, live:!document.getElementById('liveTake').hidden, liveTxt:document.querySelector('#liveTake span').textContent, body:document.body.classList.contains('recording')})")
  await pg.wait_for_timeout(int(bd*2*1000)); g2=await ev(pg,"()=>parseFloat(document.getElementById('recGrow').style.width)||0")
  ok('hud_rec_meter_elapsed_growing',h1['hud'] and h1['body'] and h1['meter']>5 and 'recorded' in h1['info'] and h1['live'] and 'recording' in h1['liveTxt'] and g2>h1['grow']>0,**h1,grow_later=g2)
  await pg.wait_for_function(f"!{F}.recording() && {F}.takes().length>=1",timeout=40000)
  t=await ev(pg,f"()=>{{const t={F}.takes().at(-1); let s=0; for(const x of t.data) s+=x*x; return {{n:{F}.takes().length,region:t.region,sung:t.sung||null,rms:Math.sqrt(s/t.data.length),len:t.data.length,sr:t.sr}}}}")
  ok('song_is_8_bars_2_sections',await ev(pg,f"()=>{F}.state.bars")==8 and len(await ev(pg,f"()=>{F}.regions()"))==2)
  ok('full_pass_take',t['n']==1 and t['region']==[0,8] and t['sung'] is None and t['rms']>1e-3 and abs(t['len']-round(8*bd*t['sr']))<2,**t)
  # 2 partial stop: 8-bar song, stop after ~3.5 bars -> kept, bars sung scored, rest "not sung"
  await ev(pg,f"()=>{F}.seekBar(0)"); await pg.click('#rec'); await pg.wait_for_timeout(int((0.1+bd*3.6)*1000)); await pg.click('#rec'); await pg.wait_for_timeout(800)
  t=await ev(pg,f"()=>{{const t={F}.takes().at(-1), sc={F}.scoresFor('voice'); const cells=sc.segs.map(s=>s.cells[t.id]&&(s.cells[t.id].notSung?'ns':'ok')); return {{n:{F}.takes().length,sung:t.sung||null,cells,status:document.getElementById('status').textContent,rec:{F}.recording()}}}}")
  s1=t['sung'][1] if t['sung'] else 0
  ok('partial_stop_kept',t['n']==2 and t['sung'] and t['sung'][0]==0 and 3<=s1<=4 and 'Kept' in t['status'] and 'ns' in t['cells'] and not t['rec'],**t)
  # 3 record from current bar (bar 4), stop after ~2.5 bars
  await pg.select_option('#recFrom','here'); await ev(pg,f"()=>{F}.seekBar(3)"); await pg.click('#rec'); await pg.wait_for_timeout(int((0.1+bd*2.5)*1000)); await pg.click('#rec'); await pg.wait_for_timeout(800)
  t=await ev(pg,f"()=>{{const t={F}.takes().at(-1); return {{n:{F}.takes().length,sung:t.sung||null,region:t.region}}}}")
  ok('record_from_current_bar',t['n']==3 and t['sung'] and t['sung'][0]==3 and 4<=t['sung'][1]<=6,**t)
  # 4 punch-in on a section (2nd section), auto-stops at the section end
  regs=await ev(pg,f"()=>{F}.regions().map(r=>[r.name,r.b0,r.b1])"); r=regs[1] if len(regs)>1 else regs[0]
  await pg.select_option('#recFrom','sec'); await ev(pg,f"()=>{F}.seekBar({r[1]})"); await pg.click('#rec')
  await pg.wait_for_function(f"!{F}.recording() && {F}.takes().length>=4",timeout=60000)
  t=await ev(pg,f"()=>{{const t={F}.takes().at(-1); return {{sung:t.sung||null,region:t.region,playing:{F}.playing(),status:document.getElementById('status').textContent}}}}")
  ok('punch_in_section',t['sung']==[r[1],r[2]] and not t['playing'] and 'Punch-in' in t['status'],section=r,regions=regs,**t)
  # 5 dry capture with the gate fully closed (threshold at max): the take still has the singer
  await pg.select_option('#recFrom','top')
  await ev(pg,"()=>{const g=document.getElementById('gateOn'); if(!g.checked) g.click(); const e=document.getElementById('g_th'); e.value=e.max; e.dispatchEvent(new Event('input'))}")
  await ev(pg,f"()=>{F}.seekBar(0)"); await pg.click('#rec'); await pg.wait_for_timeout(int((0.1+bd*2.5)*1000)); await pg.click('#rec'); await pg.wait_for_timeout(800)
  t=await ev(pg,f"()=>{{const t={F}.takes().at(-1), n=Math.round(2*{bd}*t.sr); let s=0; for(let i=0;i<n;i++) s+=t.data[i]*t.data[i]; return {{n:{F}.takes().length,rms:Math.sqrt(s/n),th:{F}.state.gate.th,gate:{F}.state.gate.on,chain:!!({F}.state.chain&&{F}.state.chain.on)}}}}")
  ok('dry_capture_gate_closed',t['n']==5 and t['rms']>1e-3 and t['th']==-10 and t['gate'],**t)
  # 6 persistence across reload (IndexedDB), partial ranges kept
  before=await ev(pg,f"()=>{F}.takes().map(t=>[t.id,t.sung||null])"); await boot(pg,clear=False); await pg.wait_for_timeout(1500)
  after=await ev(pg,f"()=>{F}.takes().map(t=>[t.id,t.sung||null])")
  ok('takes_persist_reload',len(after)==5 and sorted(map(str,after))==sorted(map(str,before)),before=before,after=after)
  # 7 AudioContext suspended -> tap to resume
  await ev(pg,f"()=>{{const c={F}.ctx(); c.suspend(); const r=c.resume.bind(c); window.__blockResume=true; c.resume=()=>window.__blockResume?Promise.resolve():r()}}")  # iOS: resume() outside a fresh tap does nothing
  await pg.wait_for_timeout(300); await pg.click('#rec'); await pg.wait_for_timeout(500)
  e=await ev(pg,"()=>({shown:!document.getElementById('recErr').hidden, txt:document.getElementById('recErr').textContent, btn:!!document.getElementById('recResume')})")
  if e['btn']: await ev(pg,'()=>{window.__blockResume=false}'); await pg.click('#recResume'); await pg.wait_for_timeout(600)
  st=await ev(pg,f"()=>({{ctx:{F}.ctx().state,shown:!document.getElementById('recErr').hidden}})")
  ok('suspended_tap_to_resume',e['shown'] and 'paused' in e['txt'] and e['btn'] and st['ctx']=='running' and not st['shown'],err=e,after=st)
  errs=[e for e in pg.errs if 'due to access control checks' not in e]  # known Playwright-WebKit/Linux fetch quirk (also on prod before this change)
  ok('no_page_errors',not errs,errors=errs[:5]); await pg.br.close()
  # 8 plain errors: permission denied / no input / unsupported
  for name,init,word in [('permission_denied',"navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('denied','NotAllowedError'))",'permission'),
                         ('no_input_device',"navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('none','NotFoundError'))",'No microphone'),
                         ('unsupported',"Object.defineProperty(navigator,'mediaDevices',{value:undefined,configurable:true});",'can')]:
    pg=await newpage(p,tag,init); await boot(pg); await pg.click('#rec'); await pg.wait_for_timeout(800)
    e=await ev(pg,f"()=>({{shown:!document.getElementById('recErr').hidden, txt:document.getElementById('recErr').textContent, rec:{F}.recording()}})")
    vis=await pg.locator('#recErr').is_visible()
    ok('error_'+name,e['shown'] and vis and word.lower() in e['txt'].lower() and not e['rec'],visible=vis,**e); await pg.br.close()
async def main():
  R={}
  async with async_playwright() as p:
    for tag in ['chromium','webkit-iphone']:
      try: await run(p,tag,R)
      except Exception as ex: R[tag+':crash']={'pass':False,'error':str(ex)[:400]}
  allp=all(v['pass'] for v in R.values()); json.dump({'url':URL,'all_pass':allp,'checks':R},open(OUT,'w'),indent=1)
  for k,v in R.items(): print(('PASS' if v['pass'] else 'FAIL'),k,'' if v['pass'] else json.dumps(v)[:500])
  print('ALL PASS' if allp else 'SOME FAILED'); sys.exit(0 if allp else 1)
asyncio.run(main())
