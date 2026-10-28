import asyncio, base64, json, sys, os
from playwright.async_api import async_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8797/'
D=os.path.dirname(os.path.abspath(__file__))
ARGS=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+D+'/demo-takes-92bpm-Am.wav']
async def main():
  async with async_playwright() as p:
    br=await p.chromium.launch(args=ARGS); c=await br.new_context(viewport={'width':1360,'height':1000}); pg=await c.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console',lambda m: m.type in('error','warning') and errs.append(m.text))
    await pg.goto(URL); await pg.evaluate("()=>{localStorage.clear(); indexedDB.deleteDatabase('takekit')}"); await pg.reload()
    await pg.click('#tapBtn'); await pg.wait_for_function("window.__takekit.ready()",timeout=90000)
    b64=base64.b64encode(open(D+'/demo-takes-92bpm-Am.wav','rb').read()).decode()
    n=await pg.evaluate("async b=>await window.__takekit.importBytes(b,'demo.wav')",b64)
    r=await pg.evaluate("""()=>{const f=window.__takekit, sc=f.scoresFor('voice'), c=f.comps(); return {n:f.takes().length, names:f.takes().map(t=>t.name), choice:c.voice.choice.map(id=>f.takes().find(t=>t.id===id)?.name||null), why:c.voice.why, best:f.takes().find(t=>t.id===c.bestVoice)?.name,
      grid:f.takes().map(t=>sc.segs.map(s=>s.cells[t.id].score+' '+s.cells[t.id].reason))}}""")
    print(json.dumps(r,indent=1)); await pg.click('#play'); await pg.wait_for_timeout(3000); await pg.screenshot(path=D+'/out/smoke.png',full_page=True); await pg.click('#play')
    print('errors',errs); await br.close()
asyncio.run(main())
