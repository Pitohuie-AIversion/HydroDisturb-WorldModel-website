"""Film the five model exhibits through the published website's normal controls."""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright


CSS = """
html,body{width:1920px;height:1080px;overflow:hidden}
body .mast{padding-inline:46px}
body .chapters{padding-inline:46px}
.mast-actions,.rail-end,.transport,.exhibit-action,.viewport-head,.viewport-foot,main footer{visibility:hidden!important}
body.process-exhibit main{display:block;padding:18px 46px 0;max-width:none}
body.process-exhibit .workbench{display:block}
body.process-exhibit #viewport{height:578px;border-radius:6px 6px 0 0}
body.wide-exhibit #viewport{height:578px}
body.process-exhibit .chapter-en{font-size:16px}
body.process-exhibit .source-tag{font-size:15px}
body.process-exhibit #chapter-head h1{font-size:73px}
body.wide-exhibit #chapter-head h1{font-size:49px}
body.process-exhibit #chapter-head p{font-size:20px;max-width:21em}
body.wide-exhibit #chapter-head p{max-width:36em}
body.process-exhibit .focus-location{font-size:16px}
.process-exhibit .process-stops button{padding:11px 25px}
.process-exhibit .process-stops button small{font-size:14px}
.process-exhibit .process-stops button strong{font-size:22px}
.process-exhibit .process-strip p{font-size:20px;line-height:1.45;padding:10px 25px}
.process-exhibit .transport{display:none}
.process-exhibit .inspector,.process-exhibit #details{position:fixed;left:-5000px;top:0;width:700px;display:block}
#film-readout{display:flex;align-items:flex-start;gap:58px;padding:15px 24px 0}
#film-readout>div{min-width:200px}
#film-readout small{display:block;color:#4a6b81;font:16px/1.25 "Microsoft YaHei",sans-serif}
#film-readout b{display:block;color:#173f58;font:600 22px/1.45 "Segoe UI","Microsoft YaHei",sans-serif;margin-top:4px}
"""


class Exhibits:
    def __init__(self, page, output, ffmpeg):
        self.page = page
        self.output = output
        self.ffmpeg = ffmpeg
        self.records = {}

    def click(self, selector):
        self.page.locator(selector).evaluate("el => el.click()")

    def slider(self, name, value):
        self.page.locator(f'[data-range="{name}"]').evaluate(
            "(el,n)=>{el.value=n;el.dispatchEvent(new Event('input',{bubbles:true}));}", value)

    def process(self, index):
        self.click(f'[data-process-index="{index}"]')
        assert self.page.locator(f'[data-process-index="{index}"]').get_attribute('aria-pressed') == 'true'

    def enter(self, index):
        self.click(f'#chapters [data-nav="{index}"]')
        self.page.locator('.model-controls').wait_for(state='attached')
        self.page.evaluate("""() => {
          const readout = document.getElementById('film-readout') || document.createElement('div');
          readout.id = 'film-readout';
          document.querySelector('.process-strip').after(readout);
        }""")
        self.page.evaluate("window.scrollTo(0,0)")

    def read(self, selector):
        return self.page.locator(selector).text_content().strip()

    def ready(self):
        self.page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def shelf(self, values):
        self.page.locator('#film-readout').evaluate("""(box, rows) => {
          box.replaceChildren(...rows.map(([label,value]) => {
            const cell = document.createElement('div');
            const key = document.createElement('small'), val = document.createElement('b');
            key.textContent=label; val.textContent=value; cell.append(key,val); return cell;
          }));
        }""", values)
        self.ready()

    def save(self, cue, rows):
        self.shelf(rows)
        self.page.screenshot(path=self.output/(cue+'.png'), animations='disabled')
        self.records[cue] = {
            'chapter': self.page.locator('body').get_attribute('data-chapter'),
            'source': self.read('#source-tag'), 'readouts': rows,
        }
        print(cue,flush=True)

    def motion(self, cue, frames, sample, hold=1):
        if not self.ffmpeg:
            return
        target = self.output / (cue + '.mp4')
        staging = target.with_suffix('.part.mp4')
        command = [str(self.ffmpeg), '-y','-loglevel','error','-f','image2pipe','-framerate',
                   str(30/hold),'-vcodec','mjpeg','-i','pipe:0','-an','-r','30','-c:v','libx264',
                   '-preset','veryfast','-crf','17','-pix_fmt','yuv420p','-threads','3',str(staging)]
        with subprocess.Popen(command, stdin=subprocess.PIPE) as writer:
            try:
                for frame in range(frames):
                    sample(frame)
                    self.ready()
                    writer.stdin.write(self.page.screenshot(type='jpeg',quality=93))
            finally:
                writer.stdin.close()
        if writer.returncode:
            raise RuntimeError(f'Could not encode {cue}')
        staging.replace(target)

    def encoder(self):
        self.enter(1)
        self.slider('focus-z',4)
        self.slider('coarse',44)
        # Project the gold selection cell into the live orthographic camera.
        # Clicking, not modifying the saved coordinates, selects the actual block.
        self.click('#reset-camera')
        self.ready()
        box = self.page.locator('#canvas-shell').bounding_box()
        aspect = box['width']/box['height']
        pixels = box['height']/max(4.4,9.5/aspect)
        normal = np.array([3.2,2.7,9.7]);normal /= np.linalg.norm(normal)
        right = np.cross([0,1,0],normal);right /= np.linalg.norm(right)
        up = np.cross(normal,right)
        point = np.array([-2.23+(8.5/24-.5)*3.36,(6.5/12-.5)*1.68,(4.5/8-.5)*1.12])
        self.page.mouse.click(box['x']+box['width']/2+pixels*np.dot(point,right),
                              box['y']+box['height']/2-pixels*np.dot(point,up))
        self.page.wait_for_function("document.querySelector('.focus-location').textContent.includes('Z 4　Y 6　X 8')")
        def rows():
            return [('编码输出',self.read('.mc-reading b')),('选中位置',self.read('.mc-reading span')),
                    ('追踪的输入块','Z 32–39　Y 48–55　X 64–71')]
        for i,cue in enumerate(['enc_input','enc_s2c1','enc_s2c2','enc_token']):
            self.process(i)
            self.page.wait_for_function("document.querySelector('.mc-reading').textContent.includes('50.04')")
            self.save(cue,rows())
            if i==1:
                def select_offset(j):
                    self.slider('offset',j);self.shelf(rows())
                self.motion(cue,8,select_offset,hold=14)
                self.slider('offset',0)

    def latent(self):
        self.enter(2)
        assert self.read('[data-name]')=='Token #1304 · ZYX (4, 6, 8)'
        self.slider('channel',37)
        raw_feature=''
        for cue,phase,norm in [('lat_position',0,True),('lat_raw',1,False),
                               ('lat_norm',1,True),('lat_probe',2,True)]:
            checkbox=self.page.locator('[data-norm]')
            if checkbox.is_checked()!=norm:
                self.click('[data-norm]')
            self.process(phase)
            labels=[('追踪位置',self.read('[data-name]')),('所选特征',self.read('[data-activation]'))]
            if cue=='lat_raw':
                raw_feature=self.read('[data-activation]')
            if cue=='lat_norm':
                labels=[labels[0],('同一特征 · 归一化前',raw_feature),('同一特征 · 归一化后',self.read('[data-activation]'))]
            elif phase==2:
                labels=[('整帧 Probe 监督目标','Enstrophy · 拟能　/　Spectrum · 能谱'),
                        ('独立的六维统计旁路 b','μu　μv　μw　μp　σuvw　σp')]
            else:
                labels.append(('向量长度','D = 256'))
            self.save(cue,labels)

    def guide_position(self, chapter, local):
        times=self.timing['starts']
        end=times[chapter+1] if chapter+1<len(times) else self.timing['duration']
        seconds=times[chapter]+local*(end-times[chapter])
        value=round(seconds/self.timing['duration']*8399)
        self.page.locator('#master').evaluate(
            "(el,n)=>{el.value=n;el.dispatchEvent(new Event('input',{bubbles:true}));}",value)

    def decoder(self):
        self.enter(3)
        for i,cue in enumerate(['dec_expand','dec_curl','dec_stats','dec_mask']):
            self.process(i)
            assert '(4, 6, 8)' in self.read('.mc-reading')
            right=[('对应输入区域','Z 32–39　Y 48–55　X 64–71'),('读出分支','A → Curl(A) → 速度脉动　｜　p′ → 压力'),
                   ('逆归一化示例',self.read('[data-decoded-value]')),('归档掩码','C04 有效流体区域 / 有效差分模板')][i]
            if i==3:
                self.page.wait_for_timeout(180)
            self.save(cue,[('当前过程',self.read('.mc-reading b')),right])
            if i==1:
                self.motion(cue,60,lambda j:self.guide_position(3,.251+.245*j/59))

    def temporal(self):
        self.enter(4)
        self.process(0)
        self.save('time_prefix',[('每帧条件','Text · Phys · Step · Action · Regime'),('历史窗口','L = 4')])
        self.process(1)
        self.save('time_clean',[('Clean 历史','t−3　→　t−2　→　t−1　→　t'),('输出缓存','各层历史 K / V')])
        for j in range(4):
            self.click(f'button[data-query="{j}"]')
            cue='time_q'+str(j+1)
            mask=self.read('[data-mask]')
            assert f'{j+1}/4' in mask
            self.save(cue,[('本次因果读取',mask),('可读历史',f'{j+1} / 4 帧')])
            self.motion(cue,42,lambda frame:self.guide_position(4,.501+.245*frame/41))
        self.click('button[data-mode="1"]')
        self.save('time_training',[('训练监督','未来真值提供目标与标签'),('统计头','仅从历史 Clean 表征读取')])

    def rollout(self):
        self.enter(6)
        self.click('button[data-forecast-source="1"]')
        self.click('button[data-field="0"]')
        for i,(cue,k) in enumerate([('roll_history',0),('roll_decode',1),('roll_fifo',2),('roll_profile',2)]):
            self.slider('k',k)
            self.page.wait_for_function("document.querySelector('[data-ref]').textContent.includes('色标')")
            self.process(i)
            assert self.page.locator('.model-controls').get_attribute('data-output')=='concept'
            assert self.read('[data-metric]')==''
            def rows():
                return [('当前目标',self.read('[data-frame-label]')),
                        ('同一剖线 · 中央 Z 截面',self.read('[data-profile-readout]'))] if i==3 else [
                            ('当前目标',self.read('[data-frame-label]')),('窗口步号',self.read('[data-window]')),
                            ('参照来源','前一归档 step 835 · 50.04 s' if k==1 else 'C04 同步真实切面')]
            if i==3:
                self.slider('profile-row',56)
            self.save(cue,rows())
            if i==3:
                def move_section(n):
                    self.slider('profile-row',48+round(n/8*8));self.shelf(rows())
                self.motion(cue,9,move_section,hold=8)


def render(url,output,ffmpeg=None,chapters=None):
    output.mkdir(exist_ok=True,parents=True)
    with sync_playwright() as api:
        browser=api.chromium.launch(channel='msedge',headless=True)
        page=browser.new_page(viewport={'width':1920,'height':1080},device_scale_factor=1)
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        guide=page.request.get(url.rstrip('/')+'/assets/guide.json').json()
        # Sample animation progress continuously while filming. The published
        # narrated tour uses named shot boundaries on the same chapter clock.
        timing={key:guide[key] for key in ('starts','duration')}
        page.route('**/assets/guide.json*',lambda route:route.fulfill(json=timing))
        page.goto(url.rstrip('/')+'/#encoder',wait_until='networkidle')
        page.add_style_tag(content=CSS)
        shoot=Exhibits(page,output,ffmpeg)
        shoot.timing=timing
        for name in chapters or ['encoder','latent','decoder','temporal','rollout']:
            getattr(shoot,name)()
        browser.close()
        if errors:
            raise RuntimeError('; '.join(errors))
    manifest=output/'model-shots.json'
    records=json.loads(manifest.read_text(encoding='utf-8')) if chapters and manifest.is_file() else {}
    records.update(shoot.records)
    manifest.write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8765/')
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--ffmpeg',type=Path,help='Also render genuine model animations as silent H.264 cues.')
    parser.add_argument('--chapters',nargs='+',choices=['encoder','latent','decoder','temporal','rollout'])
    args=parser.parse_args()
    render(args.url,args.out,args.ffmpeg,args.chapters)
