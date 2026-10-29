# Builds demo/takekit-demo-20s.mp4 from capture.py's screen recording + TakeKit's own WAV export (captions only).
import json,subprocess,sys
OUT=sys.argv[1] if len(sys.argv)>1 else 'takekit-demo-20s.mp4'
J=json.load(open('marks.json')); m=J['marks']; vid=J['video']; s1=m['s1']; dur=round(m['end']-s1,3)
caps=[(0,m['s2']-s1,"Set your BPM, key and chords. A real-sample band loops."),
 (m['s2']-s1,m['s3']-s1,"Sing pass after pass. Every bar of every take is scored:\npitch, timing, level, dropouts."),
 (m['s3']-s1,m['s4']-s1,"Auto-comp picks the best bar from each take.\nClick any cell to lock your own pick."),
 (m['s4']-s1,m['s5']-s1,"A/B: best whole take vs the comp, at matched loudness."),
 (m['s5']-s1,dur,"Export 48 kHz/24-bit WAV, MIDI and stems.\ntakekit.vercel.app  ·  $24 once")]
F='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; FR='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'; fl=[]
for i,(a,b,t) in enumerate(caps):
  open(f'cap{i}.txt','w').write(t)
  fl.append(f"drawtext=fontfile={F}:textfile=cap{i}.txt:fontsize=34:line_spacing=8:fontcolor=white:box=1:boxcolor=black@0.78:boxborderw=18:x=(w-text_w)/2:y=h-text_h-92:enable='between(t,{a:.3f},{b:.3f})'")
open('note.txt','w').write("Demo vocal: real CC0 recording (\u201cFemale-vibrato-1\u201d, Beetricks, Wikimedia Commons). Band + mix: TakeKit\x27s own WAV export.")
fl.append(f"drawtext=fontfile={FR}:textfile=note.txt:fontsize=19:fontcolor=white@0.9:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h-38")
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-ss',str(s1),'-t',str(dur),'-i',vid,'-i',J['wav'],'-map','0:v','-map','1:a','-vf',",".join(fl)+",fps=30,format=yuv420p",'-c:v','libx264','-crf','20','-preset','medium','-c:a','aac','-b:a','192k','-af','afade=t=out:st=%.3f:d=0.6'%(dur-0.6),'-shortest','-movflags','+faststart',OUT],check=True)
