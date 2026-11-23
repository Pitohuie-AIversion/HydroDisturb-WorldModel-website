"""Record the 30s UHD exhibit directly from the Vite development server.

Use --part wake, models, fm, rollout, and finally assemble. Files in the work
directory are independent, so a shot may be re-recorded without changing audio.
The film-only render overrides lift the live viewer's interactive pixel budget.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np
from PIL import Image,ImageDraw,ImageFont
from playwright.sync_api import sync_playwright

from film_model_shots import CSS as MODEL_CSS
from film_wake_fm import CSS as SCENE_CSS, MASTER_SEEK, draw
from media_voice import RATE, FPS, Speaker, write_subtitles


ROOT = Path(__file__).resolve().parents[1]
CHAPTERS = ['wake','encoder','latent','decoder','temporal','fm','rollout']
NAMES = ['涡脱落','空间编码','潜空间','物理解码','双轨时空','FM 推演','预测对照']
STARTS = [0,240,315,390,465,540,780,900]
# Offsets are video frames; narration is laid onto the same frame clock.
VOICE = [
    (0,235,'来流绕过圆柱。从零秒到六十秒，两侧涡团交替脱落，沿尾流向下游移动。'),
    (240,315,'同一区域，逐层编码。'),
    (315,390,'展开两百五十六维特征。'),
    (390,465,'解码回到原来的位置。'),
    (465,540,'查询只读可见历史。'),
    (540,650,'每一步，用当前状态重算查询，读取历史。'),
    (650,780,'求速度，乘以八分之一，加回状态。共走八步。'),
    (780,900,'模拟预测与真实截面对齐，比较偏差。'),
]
CSS = """
.data-thread,.transport,#guide-time,footer,.exhibit-action,.rail-end,.mast-actions,.view-actions{display:none!important}
body .chapters{pointer-events:none}
body.process-exhibit .process-intro #subtitle{font-size:21px}
body.process-exhibit .inspector,body.process-exhibit #details{visibility:hidden}
body[data-chapter=fm] .stage-intro{padding-top:0}
body[data-chapter=fm] .fm-panel{max-height:none}
.film-detail{margin:14px 0 0;color:#21485e;font:500 23px/1.5 "Microsoft YaHei",sans-serif}
"""


def render_page(browser,url,chapter):
    page=browser.new_page(viewport=dict(width=1920,height=1080),device_scale_factor=2)
    page.set_default_timeout(20000)
    def native_renderer(route):
        response=route.fetch()
        source=response.text()
        source,count=re.subn(r'function displayRatio\([^)]*\)\s*\{[^}]+\}',
                             'function displayRatio(){return window.devicePixelRatio;}',source,count=1)
        if not count:
            raise ValueError('Start a Vite development server for native UHD capture')
        source=re.sub(r'function adaptQuality\(([^)]*)\)\s*\{',
                      r'function adaptQuality(\1){return;',source,count=1)
        route.fulfill(response=response,body=source)
    page.route('**/src/main.ts*',native_renderer)
    def chapter_clock(route):
        response=route.fetch()
        guide=response.json()
        route.fulfill(response=response,json={k:guide[k] for k in ('duration','starts')})
    page.route('**/assets/guide.json*',chapter_clock)
    page.goto(url.rstrip('/')+'/#'+chapter,wait_until='domcontentloaded')
    page.add_style_tag(content=(SCENE_CSS if chapter in ('wake','fm') else MODEL_CSS)+CSS)
    page.wait_for_function("document.body.dataset.chapter===location.hash.slice(1) && document.querySelector('#canvas-shell canvas')")
    return page


def shoot(page,work,name):
    draw(page)
    dest=work/(name+'.jpg')
    page.screenshot(path=str(dest),type='jpeg',quality=93,scale='device')
    with Image.open(dest) as image:
        assert image.size==(3840,2160),image.size
    return dest


def save_part(work,name,intervals,details):
    count=CHAPTERS.index(name)
    assert sum(length for _,length in intervals)==STARTS[count+1]-STARTS[count]
    (work/(name+'.json')).write_text(json.dumps({
        'intervals':[(p.name,n) for p,n in intervals],'capture':details
    },ensure_ascii=False),encoding='utf8')


def wake(browser,url,work,resume=False):
    page=render_page(browser,url,'wake')
    manifest=json.loads((ROOT/'public/data/manifest.json').read_text(encoding='utf8'))
    data=manifest['frames']
    guide=page.request.get(url.rstrip('/')+'/assets/guide.json').json()
    factor=(guide['starts'][1]-.45)/80/guide['duration']*8399
    master=page.locator('#master')
    def seek(pos):
        master.evaluate(MASTER_SEEK,pos*factor)
    page.wait_for_function("document.querySelector('#stage-tag').dataset.step")
    canvas=page.locator('#canvas-shell canvas').first
    size=canvas.evaluate('e=>[e.width,e.height,e.clientWidth,e.clientHeight]')
    assert size[0]>=size[2]*1.98 and size[1]>=size[3]*1.98,('wake backing',size)
    starts=[round(i*234/80) for i in range(81)]
    intervals=[]; audit=[]
    for i,record in enumerate(data):
        n=starts[i+1]-starts[i] if i<80 else 240-starts[i]
        existing=[work/(f'wake-{i:02d}'+('' if j==0 else f'-{j}')+'.jpg') for j in range(1 if i==80 else n)]
        if resume and all(path.is_file() for path in existing):
            audit.append(record['step'])
            intervals.extend((path,n if i==80 else 1) for path in existing)
            continue
        seek(i+.000001)
        page.wait_for_function("s=>document.querySelector('#stage-tag').dataset.step===String(s)",arg=record['step'])
        # Discrete endpoints are exact archives; one intermediate per render
        # interval is the viewer's registered correspondence, never a new sample.
        image=shoot(page,work,f'wake-{i:02d}')
        intervals.append((image,n if i==80 else 1))
        audit.append(record['step'])
        if i<80:
            for j in range(1,n):
                pos=i+j/n
                expected=record['time_s']+(data[i+1]['time_s']-record['time_s'])*j/n
                for retry in range(24):
                    seek(pos);draw(page)
                    label=page.locator('#stage-time').text_content()
                    if label.startswith('≈') and abs(float(label.split()[1])-expected)<.011: break
                    if retry in (5,16):
                        for index in (i+1,i):
                            seek(index+.000001)
                            page.wait_for_function("s=>document.querySelector('#stage-tag').dataset.step===String(s)",arg=data[index]['step'])
                else:
                    # Two levels can use unequal meshes at a capture-quality
                    # boundary. Hold the exact archive if no match is available.
                    intervals.append((image,1))
                    continue
                intervals.append((shoot(page,work,f'wake-{i:02d}-{j}'),1))
        if i%10==0: print('UHD C04',i,record['time_s'],flush=True)
    save_part(work,'wake',intervals,{'grid':manifest['grid_zyx'],'size':size,'steps':audit})
    page.close()


def models(browser,url,work):
    for name,stages in [('encoder',[0,1,2,3]),('latent',[0,1]),('decoder',[0,1,3]),('temporal',[1,2])]:
        page=render_page(browser,url,name)
        intervals=[]
        times=[round(i*75/len(stages)) for i in range(len(stages)+1)]
        for i,stage in enumerate(stages):
            page.locator(f'[data-process-index="{stage}"]').evaluate('e=>e.click()')
            if name=='temporal' and stage==2:
                page.locator('[data-query="2"]').evaluate('e=>e.click()')
            page.wait_for_timeout(250)
            intervals.append((shoot(page,work,f'{name}-{stage}'),times[i+1]-times[i]))
        save_part(work,name,intervals,{'stages':stages})
        page.close();print('UHD',name,flush=True)


def fm(browser,url,work):
    page=render_page(browser,url,'fm')
    intervals=[];audit=[];z=.2
    for k in range(8):
        page.locator(f'[data-fm-knot="{k}"]').evaluate('e=>e.click()')
        velocity=1-.5*z+.25*k/8
        nxt=z+velocity/8
        vals=page.locator('[data-fm-value]').all_text_contents()
        assert vals==[f'{v:.4f}' for v in (z,velocity,velocity/8,nxt)],(k,vals)
        audit.append(vals)
        for phase,count in enumerate([5,5,8,12]):
            page.locator(f'[data-fm-stage="{phase}"]').evaluate('e=>e.click()')
            if phase==3:
                # Keep the equation visible as the representative moves to its next knot.
                for part,frac in enumerate([.25,.60,.999]):
                    page.locator('[data-range=tau]').evaluate(MASTER_SEEK,(k+frac)*12.5)
                    intervals.append((shoot(page,work,f'fm-{k}-{phase}-{part}'),4))
            else:
                intervals.append((shoot(page,work,f'fm-{k}-{phase}'),count))
        z=nxt
    save_part(work,'fm',intervals,{'z0-v-delta-z1':audit});page.close()


def rollout(browser,url,work):
    page=render_page(browser,url,'rollout')
    # Final shot compares a real future C04 frame with an independently evolved
    # teaching forecast originating at 835, with one shared slice and colour bar.
    page.wait_for_function("document.querySelector('[data-metric]')?.textContent.includes('RMSE')")
    page.locator('[data-process-index="3"]').evaluate('e=>e.click()')
    page.locator('[data-range=k]').evaluate(MASTER_SEEK,10)
    page.wait_for_timeout(550)
    assert '模拟' in page.locator('body').inner_text()
    page.wait_for_function("document.querySelector('[data-frame-label]').textContent.includes('845') && document.querySelector('[data-metric]').textContent.includes('RMSE')")
    stages=[];lines=[]
    for i,y in enumerate((48,52,56)):
        page.locator('[data-range=profile-row]').evaluate(MASTER_SEEK,y)
        if i==2: page.locator('[data-compare="1"]').evaluate('e=>e.click()')
        page.wait_for_timeout(120)
        stages.append((shoot(page,work,'rollout-'+str(y)),(36,28,56)[i]))
        lines.append(page.locator('[data-profile-readout]').text_content())
    metric=page.locator('[data-metric]').text_content()
    assert 'RMSE' in metric and all('峰' in s for s in lines)
    save_part(work,'rollout',stages,{'targetStep':845,'profiles':lines,'metric':metric});page.close()


def voice(work,ffmpeg):
    speaker=Speaker(work); speaker.voice.Rate=2
    pcm=np.zeros(30*RATE,dtype='<i2');cues=[]
    for i,(start,end,line) in enumerate(VOICE):
        audio=speaker.render('line'+str(i),line)
        lead=3; samples=(end-start-lead-2)*RATE//FPS
        if len(audio)>samples:
            speed=len(audio)/samples*1.01
            if speed>1.5:raise ValueError(f'Overlong spoken cue {line}: {speed:.2f}')
            proc=subprocess.run([str(ffmpeg),'-loglevel','error','-f','s16le','-ar',str(RATE),
                '-ac','1','-i','pipe:0','-af',f'atempo={speed:.6f}','-f','s16le','pipe:1'],
                input=audio.tobytes(),stdout=subprocess.PIPE,check=True)
            audio=np.frombuffer(proc.stdout,dtype='<i2')[:samples]
        first=(start+lead)*RATE//FPS
        pcm[first:first+len(audio)]=audio
        cues.append(dict(startFrame=start+lead,endFrame=min(end-1,start+lead+round(len(audio)*FPS/RATE)),text=line))
    with wave.open(str(work/'short.wav'),'wb') as out:
        out.setparams((1,2,RATE,0,'NONE','none'));out.writeframes(pcm.tobytes())
    for ext in ['srt','vtt']:
        write_subtitles(work/('short.'+ext),cues,ext=='vtt')
    print('Narration seconds',[(s['startFrame']/30,s['endFrame']/30) for s in cues],flush=True)


def encode_scene(work,chapter,inputs,details,ffmpeg,clip):
    labels = {
        'wake':[('物理时间','0 — 60 s'),('归档帧数','81 帧'),('涡面定义','Q = 0.85 / s²')],
        'encoder':[('输入网格 · Z × Y × X','64 × 96 × 192'),('定位到原网格','Z32–39　Y48–55　X64–71'),('空间编码输出','8 × 12 × 24 个 Token')],
        'latent':[('同一流体区域','Token #1304'),('潜网格位置','Z 4　Y 6　X 8'),('特征展开 · 教学示意','256 维')],
        'decoder':[('从同一个 Token 出发','Z 4　Y 6　X 8'),('速度读出','A → curl(A)'),('恢复物理场','u　v　w　p')],
        'temporal':[('历史窗口','4 帧 Clean'),('各层缓存','历史 K / V'),('Query 可见范围','当前及更早的槽位')],
        'fm':[('单个物理预测步','t → t + 1'),('八次速度计算','Δτ = 1/8'),('Euler 积分 · 教学示意','新状态 = 当前状态 + 速度 × Δτ')],
        'rollout':[('同一目标 · 同一截面','step 845　/　50.64 s'),('比较通道','横流速度 v　/　m/s'),('模拟预测 · 切片 RMSE',details.get('metric','').split('RMSE ')[-1].split(' · ')[0])],
    }[chapter]
    fontdir=Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'
    caption=ImageFont.truetype(str(fontdir/'msyh.ttc'),37)
    large=ImageFont.truetype(str(fontdir/'msyhbd.ttc'),60)
    panel=Image.new('RGB',(3840,234),'#f0f4f7');paint=ImageDraw.Draw(panel)
    paint.line((88,5,3752,5),fill='#bfced7',width=2)
    for (key,val),x in zip(labels,(106,1150,2440)):
        paint.text((x,32),key,font=caption,fill='#426274')
        paint.text((x,99),val,font=large,fill='#0c3450')
    bg=work/(chapter+'-measurements.png');panel.save(bg)
    playlist=['ffconcat version 1.0']
    for source,count in inputs:
        playlist.extend([f"file '{source.name}'",'option framerate 30',f'duration {count/FPS:.10f}'])
    playlist.extend([f"file '{inputs[-1][0].name}'",'option framerate 30'])
    schedule=work/(chapter+'.ffconcat');schedule.write_text('\n'.join(playlist)+'\n',encoding='ascii')
    pending=clip.with_suffix('.next.mp4')
    subprocess.run([str(ffmpeg),'-nostdin','-loglevel','error','-y','-f','concat','-safe','0','-i',schedule.name,
        '-i',bg.name,'-filter_complex_threads','2','-filter_complex',
        '[0:v]fps=30:round=near[scene];[scene][1:v]overlay=0:1748,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
        '-frames:v',str(sum(n for _,n in inputs)),'-an','-c:v','libx264','-threads','6','-crf','18','-preset','veryfast',
        '-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709','-g','60','-video_track_timescale','90000',
        str(pending)],cwd=work,check=True)
    pending.replace(clip)


def assemble(work,ffmpeg):
    voice(work,ffmpeg)
    clips=[];metadata=[';FFMETADATA1','title=FlowScope 3D · 三十秒流场展示','artist=深海智人']
    for i,ch in enumerate(CHAPTERS):
        desc=work/(ch+'.json')
        record=json.loads(desc.read_text(encoding='utf8'));records=record['intervals']
        inputs=[(work/n,k) for n,k in records]
        assert sum(n for _,n in inputs)==STARTS[i+1]-STARTS[i]
        clip=work/(ch+'-4k.mp4')
        if not clip.exists() or clip.stat().st_mtime<max(desc.stat().st_mtime,Path(__file__).stat().st_mtime):
            encode_scene(work,ch,inputs,record['capture'],ffmpeg,clip)
        clips.append("file '"+clip.name+"'")
        metadata.extend(['[CHAPTER]','TIMEBASE=1/30',f'START={STARTS[i]}',f'END={STARTS[i+1]}','title='+NAMES[i]])
    (work/'clips.txt').write_text('\n'.join(clips),encoding='ascii')
    (work/'short.ffmeta').write_text('\n'.join(metadata),encoding='utf8')
    target=ROOT/'public/media/flowscope-30s-4k.mp4';target.parent.mkdir(exist_ok=True)
    pending=work/'final.mp4'
    subprocess.run([str(ffmpeg),'-nostdin','-loglevel','error','-y','-f','concat','-safe','0','-i','clips.txt',
        '-i','short.wav','-i','short.srt','-f','ffmetadata','-i','short.ffmeta','-map','0:v','-map','1:a',
        '-map','2:s','-map_metadata','3','-map_chapters','3','-c:v','copy','-c:a','aac','-b:a','144k',
        '-c:s','mov_text','-disposition:s:0','0','-metadata:s:a:0','language=zho','-metadata:s:s:0','language=zho',
        '-movflags','+faststart',str(pending)],cwd=work,check=True)
    for source,dest in [(pending,target),(work/'short.vtt',target.with_suffix('.vtt'))]:
        staged=dest.with_name(dest.name+'.partial');shutil.copyfile(source,staged);os.replace(staged,dest)
    print(target, target.stat().st_size,flush=True)


if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--url',default='http://127.0.0.1:5181')
    ap.add_argument('--work',type=Path,default=Path(tempfile.gettempdir())/'flowscope-4k-short')
    ap.add_argument('--part',required=True,choices=['wake','models','fm','rollout','voice','assemble'])
    ap.add_argument('--resume-wake',action='store_true',help='Reuse endpoints from an interrupted capture of this same viewer and C04 archive.')
    ap.add_argument('--ffmpeg',default=shutil.which('ffmpeg') or 'ffmpeg')
    args=ap.parse_args();args.work=args.work.resolve();args.work.mkdir(exist_ok=True,parents=True)
    if args.part in ('voice','assemble'):
        (voice if args.part=='voice' else assemble)(args.work,args.ffmpeg)
    else:
        with sync_playwright() as api:
            browser=api.chromium.launch(channel='msedge',headless=True)
            try:
                capture={'wake':wake,'models':models,'fm':fm,'rollout':rollout}[args.part]
                if args.part=='wake':
                    capture(browser,args.url,args.work,resume=args.resume_wake)
                else:
                    capture(browser,args.url,args.work)
            finally:browser.close()
