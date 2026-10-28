# Records the demo screen capture (silent webm) and the real exported WAV it is paired with.
import asyncio, base64, json, os, time
from playwright.async_api import async_playwright
D=os.path.dirname(os.path.abspath(__file__)); Q=os.path.join(D,'..','qa'); URL='http://localhost:8797/'
async def main():
  async with async_playwright() as p:
    br=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    c=await br.new_context(viewport={'width':1280,'height':720},record_video_dir=D+'/raw',record_video_size={'width':1280,'height':720}); pg=await c.new_page(); T0=time.time(); marks={}
    mark=lambda k: marks.__setitem__(k,round(time.time()-T0,3))
    await pg.goto(URL); await pg.evaluate("()=>{localStorage.clear(); indexedDB.deleteDatabase('takekit')}"); await pg.reload()
    await pg.click('#tapBtn'); await pg.wait_for_function("window.__takekit.ready()",timeout=90000)
    b64=base64.b64encode(open(Q+'/demo-takes-92bpm-Am.wav','rb').read()).decode(); await pg.evaluate("async b=>await window.__takekit.importBytes(b,'demo.wav')",b64)
    await pg.evaluate("()=>window.scrollTo(0,0)"); await pg.wait_for_timeout(400)
    mark('s1'); await pg.click('#play'); await pg.wait_for_timeout(3800)
    mark('s2'); await pg.evaluate("()=>document.querySelector('.takes').scrollIntoView({behavior:'smooth'})"); await pg.wait_for_timeout(1200)
    for sel in ['.cell[data-seg=\"1\"]','.cell[data-seg=\"4\"]']:
      cells=await pg.query_selector_all(sel)
      if cells: await cells[0].hover(); await pg.wait_for_timeout(1300)
    await pg.wait_for_timeout(1000)
    mark('s3'); await pg.evaluate("()=>document.querySelector('.comprow').scrollIntoView({block:'center',behavior:'smooth'})"); await pg.wait_for_timeout(1500)
    cells=await pg.query_selector_all('.cell[data-seg=\"0\"]')
    await cells[0].click(); await pg.wait_for_timeout(1700)
    cells=await pg.query_selector_all('.cell[data-seg=\"0\"]'); await cells[0].click(); await pg.wait_for_timeout(1300)
    mark('s4'); await pg.click('#abA'); await pg.wait_for_timeout(1800); await pg.click('#abB'); await pg.wait_for_timeout(1800)
    mark('s5'); await pg.evaluate("()=>document.querySelector('.export').scrollIntoView({block:'center',behavior:'smooth'})"); await pg.wait_for_timeout(1200)
    await pg.click('#wav'); await pg.wait_for_timeout(2500); mark('end'); await pg.click('#play')
    r=await pg.evaluate("async()=>{const f=window.__takekit; const w=await f.exportWavBytes(); let s=''; for(let i=0;i<w.bytes.length;i+=32768) s+=String.fromCharCode.apply(null,w.bytes.subarray(i,i+32768)); return {name:w.name,b64:btoa(s)}}")
    open(D+'/'+r['name'],'wb').write(base64.b64decode(r['b64'])); vp=await pg.video.path(); await c.close(); await br.close()
    json.dump({'marks':marks,'video':vp,'wav':r['name']},open(D+'/marks.json','w'),indent=1); print(marks, vp, r['name'])
asyncio.run(main())
