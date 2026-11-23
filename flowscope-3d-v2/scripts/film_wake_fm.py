"""Capture the C04 and FM sequences from the running FlowScope viewer at 1080p30.

The normal guide and inspector controls drive every captured frame. No model
weights or time interpolation are invented by this exporter.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

from playwright.sync_api import sync_playwright

FPS = 30
WIDTH, HEIGHT = 1920, 1080
DEFAULT_OUT = Path(os.environ.get("TEMP", ".")) / "flowscope-film-r16"
CSS = """
.mast-actions,.view-actions,#camera-hint,.transport,#details,footer{display:none!important}
.mast,.chapters{padding-inline:44px!important}
html,body{overflow:hidden}
main{max-width:none!important;padding:20px 44px!important}
body[data-chapter="wake"] #viewport.field-view{height:622px!important}
body[data-chapter="wake"].compare #viewport.field-view{height:425px!important}
body.compare .wake-specs,body.compare #viewport .viewport-head,body.compare #viewport .viewport-foot{display:none!important}
body.compare .stage-intro h1{font-size:64px!important}
body.compare .stage-intro p{font-size:20px!important}
.film-cut{position:absolute;inset:0;z-index:2;background:#0b2a43}
body[data-chapter="wake"] .inspector,body[data-chapter="wake"]:not(.compare) .wake-atlas{display:none!important}
.wake-time-buttons,.wake-time-modes{display:none!important}
.wake-timeline{grid-template-columns:1fr!important}
.wake-atlas canvas{height:127px!important}
.wake-atlas button span{font-size:17px!important}
.wake-atlas button span small{font-size:14px!important}
.wake-atlas header p{font-size:14px!important}
.fm-view{height:452px!important}
body[data-chapter="fm"] .workbench{grid-template-columns:minmax(0,1fr) 425px!important;gap:16px}
body[data-chapter="fm"] #chapter-head h1{font-size:49px!important;margin:5px 0!important}
body[data-chapter="fm"] #chapter-head{margin-bottom:12px}
body[data-chapter="fm"] .inspector{max-height:none;overflow:visible}
.fm-lesson-transport,.fm-controls-row,.fm-panel>.mc-check,.fm-panel .mc-details,.fm-panel .mc-reset{display:none!important}
.fm-panel{gap:15px!important}
.fm-score-heading h3,.fm-step-heading strong,.fm-calc header strong{font-size:19px!important}
.fm-score-heading span,.fm-step-heading span{font-size:16px!important}
.fm-calc dl{padding:16px!important;gap:14px 12px!important}
.fm-calc dd{font-size:24px!important}.fm-calc dt{font-size:17px!important}
.fm-calc .fm-equation{font-size:16px!important}
.fm-phase-track button span,.fm-score>p,.fm-states{font-size:17px!important}
.fm-phase-track strong,.fm-evidence{font-size:19px!important}
"""
MASTER_SEEK = """(e, value) => {
  e.step='any'; e.value=String(value); e.dispatchEvent(new Event('input',{bubbles:true}));
}"""


def draw(page):
    page.evaluate("() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")


def take(page, file):
    draw(page)
    page.screenshot(path=str(file), **({"type":"jpeg","quality":94} if file.suffix == ".jpg" else {}))


def render_intervals(ffmpeg, media, intervals, destination):
    """Use integer frame boundaries; ffconcat rounds the input timebase to 1/30."""
    lines = ["ffconcat version 1.0"]
    total = 0
    for image, count in intervals:
        if count < 1:
            raise ValueError(f"Empty timed exposure in {destination}: {image.name} {count}")
        assert image.is_file() and image.parent == media
        lines.extend([f"file '{image.name}'", "option framerate 30", f"duration {count/FPS:.10f}"])
        total += count
    lines.extend([f"file '{intervals[-1][0].name}'", "option framerate 30"])
    playlist = media / (destination.stem + ".ffconcat")
    playlist.write_text("\n".join(lines)+"\n", encoding="ascii")
    subprocess.run([str(ffmpeg),"-hide_banner","-loglevel","error","-nostdin","-y",
                    "-f","concat","-safe","0","-i",playlist.name,"-an",
                    "-vf","fps=30:round=near","-frames:v",str(total),
                    "-c:v","libx264","-pix_fmt","yuv420p","-preset","veryfast",
                    "-threads","4","-crf","17","-video_track_timescale","90000",
                    "-movflags","+faststart",str(destination)],check=True,cwd=media)


def page_at(browser, url, chapter):
    page = browser.new_page(viewport={"width":WIDTH,"height":HEIGHT},device_scale_factor=1)
    if chapter=="wake":
        def uniform_guide(route):
            response=route.fetch()
            clock=response.json()
            route.fulfill(response=response,json={"starts":clock["starts"],"duration":clock["duration"]})
        page.route("**/assets/guide.json*",uniform_guide)
    page.goto(url.split("#")[0]+"#"+chapter, wait_until="domcontentloaded")
    page.add_style_tag(content=CSS)
    page.locator("#canvas-shell canvas").first.wait_for()
    return page


def wake_film(browser, url, media, shots, timeline, ffmpeg):
    page = page_at(browser,url,"wake")
    asset_url = page.evaluate("new URL('.', location.href).href")
    frames = page.request.get(asset_url+"data/manifest.json").json()["frames"]
    guide = page.request.get(asset_url+"assets/guide.json").json()
    assert len(frames)==81 and frames[0]["time_s"]==0 and frames[-1]["time_s"]==60
    # Guide times may change after publishing the companion film. Read the
    # current guide metadata; r15 uses one uniform sweep ending in a .45s hold.
    guide_start,guide_end=0,guide["starts"][1]-.45
    factor=(guide_end-guide_start)/80/guide["duration"]*8399
    offset=guide_start/guide["duration"]*8399
    master=page.locator("#master")
    def seek_guide(position):
        master.evaluate(MASTER_SEEK, offset+factor*position)
    def go_to_archive(i):
        frame=frames[i]
        # Crossing a boundary runs the viewer's real presentation/prefetch path.
        seek_guide(i+.00001)
        page.wait_for_function("s=>document.querySelector('#stage-tag').dataset.step===String(s)",arg=frame["step"])
        if page.locator("#stage-time").inner_text().startswith("≈"):
            page.locator("#physical-time").evaluate(MASTER_SEEK,frame["time_s"])
        return f"{frame['time_s']:.2f} s / 60 s"
    page.wait_for_function("document.querySelector('#stage-tag').dataset.step")
    go_to_archive(1)
    total=timeline["wake.play"]["frames"]; assert total==240
    # Leave the final 0.50 seconds visible and include an exact rendered sample
    # from each of the 81 archives. Intermediate pixels are the viewer's own
    # registered three-dimensional display transitions.
    last_at=total-15
    starts=[round(i*last_at/80) for i in range(81)]
    intervals=[]
    audit=[]
    for i, frame in enumerate(frames):
        exact=go_to_archive(i)
        page.wait_for_function("t=>document.querySelector('#stage-time').textContent===t",arg=exact)
        endpoint=media/f"wake-{i:02d}-0.jpg"
        take(page,endpoint)
        if i==0:
            take(page,shots/"wake.start.png")
        n=starts[i+1]-starts[i] if i<80 else total-starts[i]
        time_samples=[]
        intervals.append((endpoint,n if i==80 else 1))
        for j in range(1, 1 if i==80 else n):
            t=frame["time_s"]+(frames[i+1]["time_s"]-frame["time_s"])*j/n
            position=i+j/n
            label=f"≈ {t:.2f} s / 60 s"
            # Wait until the time stamp confirms the GPU transition was applied.
            # A fresh uncached pair may have finished reading just after the
            # previous guide seek, so repeat that same public input when needed.
            for retry in range(22):
                seek_guide(position)
                draw(page)
                current=page.locator("#stage-time").inner_text()
                if current.startswith("≈") and abs(float(current.split()[1])-t)<.011:
                    break
                if retry in (4,12):
                    go_to_archive(i+1)
                    go_to_archive(i)
            else:
                raise RuntimeError(f"C04 transition {i}+{j}/{n} unavailable: {label}, saw {current}")
            inter=media/f"wake-{i:02d}-{j}.jpg"
            take(page,inter)
            intervals.append((inter,1))
            time_samples.append(current)
        audit.append({"step":frame["step"],"physical_s":frame["time_s"],"videoFrame":starts[i],"intermediate":time_samples})
        if i%10==0:
            print("C04 archive",i,frame["time_s"],flush=True)
    assert sum(length for _,length in intervals)==total
    render_intervals(ffmpeg,media,intervals,shots/"wake.play.mp4")
    (media/"wake-audit.json").write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding="utf8")
    capture_landmarks(page,asset_url,media,shots,timeline,ffmpeg)
    page.close()


def capture_landmarks(page,asset_url,media,shots,timeline,ffmpeg):
    marks=page.request.get(asset_url+"assets/wake-landmarks.json").json()["landmarks"]
    meta=page.request.get(asset_url+"data/manifest.json").json()
    page.locator("body").evaluate("e=>e.classList.add('compare')")
    page.locator(".wake-atlas button").last.wait_for()
    pairs=[("wake.lower",[835,847]),("wake.upper",[851,867])]
    for pair,(cue,steps) in enumerate(pairs):
        row=timeline[cue]; second=row["subtitles"][1]["startFrame"]-row["startFrame"]
        intervals=[]
        for j,step in enumerate(steps):
            page.locator(".wake-atlas button").nth(2*pair+j).click()
            page.wait_for_function("s=>document.querySelector('#stage-tag').dataset.step===String(s) && document.querySelector('#loading').hidden",arg=step)
            assert page.locator('[data-view="slice"]').get_attribute("aria-pressed")=="true"
            assert page.locator("#slice-position").input_value()=="32"
            assert page.locator("#physical-keys [data-ch=v]").get_attribute("aria-pressed")=="true"
            # Enlarge the selected archive cut itself. The public atlas canvas
            # already carries the ring found from the verified signed maximum.
            # Keep the card visible below as the source of this close-up.
            page.evaluate("""({mark,axes,side})=>{
              let c=document.querySelector('.film-cut');
              if(!c){c=document.createElement('canvas');c.className='film-cut';document.querySelector('#canvas-shell').append(c)}
              const src=document.querySelector('.wake-atlas button[aria-pressed=true] canvas');
              const [W,H]=[c.clientWidth,c.clientHeight];c.width=W;c.height=H;
              const ctx=c.getContext('2d');
              ctx.fillStyle='#0b2a43';ctx.fillRect(0,0,W,H);
              const X=axes.X,Y=axes.Y,dx=X[1]-X[0],dy=Y[1]-Y[0];
              const x0=X[0]-dx/2,x1=X.at(-1)+dx/2,y1=Y.at(-1)+dy/2,y0=Y[0]-dy/2;
              const left=-.47,right=1.47,top=.4,bottom=-.4;
              const h=H-113,w=h*(right-left)/(top-bottom),cx=(W-w)/2,cy=50;
              ctx.drawImage(src,(left-x0)/(x1-x0)*src.width,(y1-top)/(y1-y0)*src.height,
                            (right-left)/(x1-x0)*src.width,(top-bottom)/(y1-y0)*src.height,cx,cy,w,h);
              ctx.strokeStyle='#77b5d5';ctx.lineWidth=1;ctx.strokeRect(cx,cy,w,h);
              ctx.fillStyle='#c8eafa';ctx.font='600 18px "Microsoft YaHei",sans-serif';
              ctx.fillText('Z = 32　·　横流速度 v　·　圆环为展向涡量的局部峰',cx,cy-17);
              ctx.font='16px Consolas,monospace';ctx.textAlign='center';
              for(const x of [0,.3,.6,.9,1.2]){
                const xx=cx+(x-left)/(right-left)*w;ctx.beginPath();ctx.moveTo(xx,cy+h);ctx.lineTo(xx,cy+h+7);ctx.stroke();
                ctx.fillText(x.toFixed(1)+' m',xx,cy+h+28);
              }
              ctx.textAlign='left';ctx.fillText('X →',cx+w-36,cy+h+46);
              const title=document.querySelector('#title');title.replaceChildren(side);
              const accent=document.createElement('span');accent.textContent='向下游移动';title.append(accent);
              document.querySelector('#subtitle').textContent='X = '+mark.x_m.toFixed(3)+' m　·　ωz = '+mark.omega_z.toFixed(2)+' s⁻¹';
            }""",{"mark":marks[pair*2+j],"axes":meta["axes_m"],"side":"下侧正涡" if pair==0 else "上侧负涡"})
            file=media/f"{cue}-{j}.jpg"
            take(page,file)
            intervals.append((file,second if j==0 else row["frames"]-second))
        render_intervals(ffmpeg,media,intervals,shots/(cue+".mp4"))


def fm_film(browser,url,media,shots,timeline,ffmpeg):
    page=page_at(browser,url,"fm")
    phase=page.locator("[data-fm-stage]")
    slider=page.locator("[data-range=tau]")
    def select(k,p):
        page.locator("[data-fm-knot]").nth(k).click()
        phase.nth(p).click()
        page.evaluate("window.scrollTo(0,0)")
    select(0,0)
    for name,p in [("setup",0),("query",0),("history",1),("velocity",2)]:
        phase.nth(p).click()
        take(page,shots/f"fm.{name}.png")
    z=.2
    audit=[]
    for k in range(8):
        cue=f"fm.step{k+1}"
        row=timeline[cue]
        total=row["frames"]
        boundary=row["subtitles"][1]["startFrame"]-row["startFrame"]
        select(k,0)
        v=1-.5*z+.25*k/8
        new_z=z+v/8
        values=page.locator("[data-fm-value]").all_text_contents()
        assert values==[f"{num:.4f}" for num in (z,v,v/8,new_z)], (k,values,z,v,new_z)
        audit.append(dict(step=k+1,tau=k/8,readout=values,equation=page.locator("[data-fm-equation]").inner_text()))
        phases=[]
        for p in range(4):
            phase.nth(p).click()
            file=media/f"{cue}-phase{p}.jpg"
            take(page,file);phases.append(file)
        # The velocity is held in phase 2 for the spoken value. Phase 3 opens
        # at the next spoken sentence and the cursor advances along the segment.
        if k==0:
            lead=[(phases[2],boundary)]
        else:
            q_len=max(12,min(29,boundary//4))
            h_len=max(8,min(18,boundary//7))
            lead=[(phases[0],q_len),(phases[1],h_len),(phases[2],boundary-q_len-h_len)]
        motion=[]
        for tick in range(1,25):
            slider.evaluate(MASTER_SEEK,(k+tick/25)*12.5)
            file=media/f"{cue}-move{tick:02d}.jpg"
            take(page,file)
            motion.append((file,2))
        # Conclude on the indicated next state. On the web, crossing the knot
        # makes that value the current state for the next Query.
        slider.evaluate(MASTER_SEEK,(k+1)*12.5)
        file=media/f"{cue}-landed.jpg"
        take(page,file)
        end_caption=page.locator("[data-fm-value=next]" if k==7 else "[data-fm-value=current]").inner_text()
        assert end_caption==f"{new_z:.4f}",(k,end_caption,new_z)
        # Keep this step's equation visible while the narrator reads its
        # inputs. Reach the next knot at the very end of the spoken result.
        last_hold=total-(row["subtitles"][-1]["endFrame"]-row["startFrame"])+4
        first_hold=total-boundary-last_hold-sum(n for _,n in motion)
        assert first_hold>=8
        assert last_hold>=8
        intervals=lead+[(phases[3],first_hold)]+motion+[(file,last_hold)]
        assert sum(n for _,n in intervals)==total
        render_intervals(ffmpeg,media,intervals,shots/(cue+".mp4"))
        print(cue,values,flush=True)
        z=new_z
    assert page.locator("[data-out=tau]").inner_text()=="1.00"
    take(page,shots/"fm.end.png")
    (media/"fm-audit.json").write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding="utf8")
    page.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url",default="http://127.0.0.1:8765/?v=sealien-r15")
    parser.add_argument("--out",type=Path,default=DEFAULT_OUT)
    parser.add_argument("--ffmpeg",type=Path,default=shutil.which("ffmpeg") or "ffmpeg")
    parser.add_argument("--chapter",choices=["wake","landmarks","fm","both"],default="both")
    args=parser.parse_args()
    args.out=args.out.resolve()
    media=args.out/"wake-fm-work"; shots=args.out/"shots"
    media.mkdir(parents=True,exist_ok=True);shots.mkdir(parents=True,exist_ok=True)
    metadata=json.loads((args.out/"voice"/"timeline.json").read_text(encoding="utf8"))
    timeline={s["id"]:s for s in metadata["shots"]}
    with sync_playwright() as context:
        browser=context.chromium.launch(channel="msedge",headless=True)
        try:
            if args.chapter=="landmarks":
                page=page_at(browser,args.url,"wake")
                capture_landmarks(page,page.evaluate("new URL('.',location.href).href"),media,shots,timeline,args.ffmpeg)
                page.close()
            if args.chapter in ("wake","both"):
                wake_film(browser,args.url,media,shots,timeline,args.ffmpeg)
            if args.chapter in ("fm","both"):
                fm_film(browser,args.url,media,shots,timeline,args.ffmpeg)
        finally:
            browser.close()

if __name__=="__main__":
    main()

