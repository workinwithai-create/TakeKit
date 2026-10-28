# TakeKit research notes (2026-10-28)

Source: public X search (x MCP, search_posts_all), Sep 1 to Oct 28 2026. The question was where producers and songwriters stall when FINISHING a song, in areas Mark's products cover (VocalForge / AuraStudio / MixForge vocals, Sideman backing).

## The gap: picking and stitching the best vocal take ("comping")
Arrangement is covered by FinishKit. The step people keep naming after that is the vocal: they sing 5 to 20 passes, then lose hours choosing lines and hiding the edits.

| Post | What it says |
|---|---|
| https://x.com/vitricaudio/status/2114331967688970320 (Oct 25) | Asked what eats the most studio time: "Comping vocals, by a mile. Choosing between eight takes of the same line eats more hours than all the sound design put together." (reply to K-391) |
| https://x.com/OliviaRubis/status/2110130907499917600 (Oct 13) | "The reason it takes me so long to finish songs is because I'm so ocd with the vocals ... I will keep redoing them" |
| https://x.com/kiamemusic/status/2105140599380918598 (Sep 30) | Finished recording vocals; shows the take count "just for the mains" (43 likes) |
| https://x.com/adamchadmusic/status/2110273475831328981 (Oct 14) | "the hard part of a vocal comp is never the cut. It's matching breath, room tone and pitch drift so nobody hears the seam" |
| https://x.com/mochittini/status/2095364006928335269 (Sep 3) | Struggled to comp vocals in Ableton and went back to Logic |
| https://x.com/DaveTravishth7/status/2111786561520164887 (Oct 18) | The method: 3–5 full passes, pick lines for feel, then pitch and timing, cut on breaths, short crossfades |
| https://x.com/dalevirgo/status/2102549328367640673 (Sep 23) | "Compare complete passes first ... repair details without losing its character." Don't build a comp one word at a time. |
| https://x.com/MeAuricSoul/status/2114897573177938313 (Oct 27) | Tutorial demand: how to lock in a vocal comp in Logic (take folder → flatten) |

## Why it isn't covered yet
- FinishKit handles parts, sections, transitions, endings and feel. It has no takes and no comping.
- HumEight, WordFour, BoxFour and EarFour record a take on every loop pass, but you keep or discard each take whole. None scores the takes or stitches the best bars together.
- VocalForge and MixForge process a finished vocal. TakeKit sits one step before them and hands them the comped vocal.
- DAW take folders (Logic, Pro Tools, Cubase) make you audition every lane by ear. Browser tools offer nothing here.

## What TakeKit does about it
- Loop your chords on a real-sample band at your BPM and key. Every loop pass is a take: the mic as dry audio, a MIDI keyboard as notes. You can also import takes from your DAW.
- Each bar (or half bar or 2 bars) of each take gets a pitch score (cents off, out of key), a timing score (onsets against the grid), a level score (against the other takes, plus clipping) and a presence score (dropouts).
- Auto-comp picks the best take per segment. A "keep whole passes" penalty follows dalevirgo's advice, so it doesn't jump takes every bar.
- Seams move to the quietest point near the bar line (a breath or consonant) with a short equal-power crossfade. That addresses adamchadmusic's seam point.
- Click any cell to pick and lock it. Auto-comp never overrides a lock. A/B compares A (the best single whole take) against B (the comp) at matched loudness.
