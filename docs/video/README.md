# MORE explainer video

**MORE: Margin On RWA Exposure, without liquidation.**

This folder holds the source of the 3 minute explainer video. The video is
built in code with Remotion. Every scene is drawn in `remotion/src/Explainer.tsx`.

## Files

| Path | Content |
|---|---|
| `remotion/src/Explainer.tsx` | All scenes, the timeline, and the voice timing |
| `remotion/public/voice/` | The voice recordings |
| `remotion/public/sb-*.png` | Illustrations used in four scenes |
| `voice-script.md` | The voice script, one line for each scene |
| `leverage-pool-explainer.html` | An interactive page that explains the pool math |
| `idea-notes.md` | The idea and the research notes |

## Render the video

1. Go to `docs/video/remotion`.
2. Run `npm install`.
3. Run `npm run render`.

The result is `remotion/out/more.mp4`. The `out` folder is not in git.

To see the video in a browser while you edit, run `npm run studio`.

## How the timing works

The `VOICE` table in `Explainer.tsx` has one row for each scene: the start
and the end of its voice line in the audio, and the scene length in frames.
A scene that is shorter than its design length plays its animation faster.

## Numbers in the video

The pool example uses 2 bNVDA at 100 USD, with a sell limit of 2.67x, a buy
limit of 1.6x and a target of 2x. These match the contract defaults. The
three markets in the launchpad scene are examples, not final settings.
