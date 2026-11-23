"""Regression checks against a running copy of the offline presentation.

Requires Playwright and an installed Chromium-family browser. Blocks every HTTP
request outside the chosen local origin, including third-party script requests.
"""
import argparse
import json
import struct
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from benchmark_viewer import MOTION_PIXELS


def set_range(page, selector, value):
    page.locator(selector).fill(str(value))


def chapter(page, index):
    page.locator(f'.chapter-btn[data-nav="{index}"]').click()
    expect(page.locator(f'.chapter-btn[data-nav="{index}"]')).to_have_attribute('aria-current', 'step')


def check_film_seeks(page, url, native_only=False):
    """Seek non-sequentially through the spoken cues, including phrase cuts inside one shot."""
    guide=page.request.get(url+'assets/guide.json').json()
    shots={s['id']:s for s in guide['shots']}
    def seek(id_, offset=2):
        shot=shots[id_]
        time=(shot['startFrame']+offset)/guide['fps']
        set_range(page,'#master',round(time/guide['duration']*8399))
        expect(page.locator('.chapter-btn[aria-current=step]')).to_have_attribute('data-nav',str(shot['chapter']-1))
    if not native_only:
        seek('wake.upper',shots['wake.upper']['subStarts'][1]+3)
        expect(page.locator('#stage-tag')).to_have_attribute('data-step','867')
        expect(page.locator('[data-view=slice]')).to_have_attribute('aria-pressed','true')
        seek('enc_token')
        expect(page.locator('[data-layer="3"]')).to_have_attribute('aria-pressed','true')
        seek('lat_raw')
        expect(page.locator('[data-norm]')).not_to_be_checked()
        seek('lat_norm')
        expect(page.locator('[data-norm]')).to_be_checked()
        seek('dec_mask')
        expect(page.locator('[data-decoder-step="3"]')).to_have_attribute('aria-pressed','true')
        for i in (1,4,2):
            seek('time_q'+str(i))
            expect(page.locator('[data-mask]')).to_contain_text(f'（{i}/4 帧）')
        seek('time_training')
        expect(page.locator('button[data-mode="1"]')).to_have_attribute('aria-pressed','true')
    for i in (8,2,5):
        shot=shots[f'fm.step{i}']
        seek(shot['id'],shot['subStarts'][1]+4)
        expect(page.locator('[data-fm-knot="'+str(i-1)+'"]')).to_have_attribute('aria-pressed','true')
        expect(page.locator('[data-fm-stage="3"]')).to_have_attribute('aria-pressed','true')
    seek('fm.end')
    expect(page.locator('[data-out=tau]')).to_have_text('1.00')
    seek('roll_profile',shots['roll_profile']['frames']-4)
    expect(page.locator('[data-range=k]')).to_have_value('2')
    expect(page.locator('[data-range=profile-row]')).to_have_value('56')
    expect(page.locator('[data-frame-label]')).to_contain_text('837')


def watch_wake_geometry(context, page, url):
    """Identify Q-surface submissions by the archived GLB index count and step."""
    manifest = context.request.get(url + 'data/manifest.json').json()
    counts = {}
    frames = manifest['frames']
    assert len(frames) == 81
    assert [(f['step'], f['time_s']) for f in (frames[0], frames[1], frames[-1])] == [(1, 0), (5, .24), (1001, 60)]
    for frame in frames:
        for lod in ('structure', 'structureLow'):
            asset = frame['assets'].get(lod)
            if asset:
                response = context.request.get(url + 'data/' + asset['path'], headers={'Range': 'bytes=0-65535'})
                assert response.ok
                data = response.body()
                response.dispose()
                size = struct.unpack_from('<I', data, 12)[0]
                glb = json.loads(data[20:20+size])
                count = max(glb['accessors'][part['indices']]['count']
                            for mesh in glb['meshes'] for part in mesh['primitives'])
                counts.setdefault(count, []).append(frame['step'])
    page.add_init_script("""(() => {
        const counts = """ + json.dumps(counts) + """;
        window.wakePaints = [];
        const draw = WebGL2RenderingContext.prototype.drawElements;
        WebGL2RenderingContext.prototype.drawElements = function(mode,count,...rest) {
            const result=draw.call(this,mode,count,...rest);
            if(mode!==this.TRIANGLES || !counts[count])return result;
            // The renderer publishes the step and clock when its submission completes.
            queueMicrotask(()=>{
                const clock=document.querySelector('#physical-clock');
                const step=Number(document.querySelector('#stage-tag')?.dataset.step);
                if(clock && counts[count].includes(step) && window.wakePaints.at(-1)?.step!==step){
                    window.wakePaints.push({step, label:clock.textContent,
                        time:Number(document.querySelector('#physical-time').value), wall:performance.now()});
                }
            });
            return result;
        };
    })()""")
    return frames


def expect_origin(page):
    page.wait_for_function("window.wakePaints.length>0", timeout=45000)
    first = page.evaluate("window.wakePaints[0]")
    assert (first['step'], first['time'], first['label']) == (1, 0, '0.00 s'), first


def check_autoplay(page, frames):
    expect_origin(page)
    expect(page.locator('#wake-rate')).to_have_value('compact')
    expect(page.locator('#cycle')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#tour')).to_have_attribute('aria-pressed', 'false')
    page.wait_for_function("window.wakePaints.at(-1)?.step===1001", timeout=120000, polling=80)
    expect(page.locator('#cycle')).to_have_attribute('aria-pressed', 'false')
    expect(page.locator('#physical-time')).to_have_value('60')
    expect(page.locator('#physical-clock')).to_have_text('60.00 s')
    page.wait_for_timeout(550)
    paints = page.evaluate("window.wakePaints")
    assert [p['step'] for p in paints] == [f['step'] for f in frames], [p['step'] for p in paints]
    assert [p['label'] for p in paints] == [f"{f['time_s']:.2f} s" for f in frames]
    expect(page.locator('#master')).to_have_value('0')
    expect(page.locator('.chapter-btn[aria-current=step]')).to_have_attribute('data-nav', '0')
    print(f"PASS: all 81 archived CFD draws in compact playback, 0–60 s in {(paints[-1]['wall']-paints[0]['wall'])/1000:.2f} wall seconds.", flush=True)

    # Compare wall time over the same physical samples at both ends of the speed selector.
    timings = {}
    for speed in ('0.5', '4'):
        page.locator('#wake-rate').select_option(speed)
        expect(page.locator('#cycle')).to_have_attribute('aria-pressed', 'false')
        expect(page.locator('#rate')).to_have_value('1')
        # Carry the displayed endpoint across the click. An unchanged redraw
        # while step 1 is loading is still the same displayed sample.
        page.locator('#cycle').evaluate("""button=>button.addEventListener(
            'click',()=>{window.wakePaints=window.wakePaints.slice(-1)},{once:true,capture:true})""")
        page.locator('#cycle').click()
        page.wait_for_function("window.wakePaints.some(f=>f.step===33)")
        page.locator('#cycle').click()
        assert page.evaluate("window.wakePaints[0].step") == 1001
        paints = page.evaluate("window.wakePaints.slice(1)")
        assert [p['step'] for p in paints[:9]] == [f['step'] for f in frames[:9]], (speed, paints)
        timings[speed] = paints[8]['wall'] - paints[1]['wall']
        expect(page.locator('#cycle')).to_have_attribute('aria-pressed', 'false')
        paused = page.locator('#physical-time').input_value()
        page.wait_for_timeout(450)
        assert page.locator('#physical-time').input_value() == paused
        if speed == '0.5':
            page.locator('#cycle').click()
            page.wait_for_function("v=>Number(document.querySelector('#physical-time').value)>Number(v)", arg=paused)
            page.locator('#wake-rate').select_option('1')
            expect(page.locator('#cycle')).to_have_attribute('aria-pressed', 'true')
            set_range(page, '#physical-time', 60)
            expect(page.locator('#stage-tag')).to_have_attribute('data-step', '1001')
    assert timings['0.5'] > timings['4'] * 2, timings
    page.locator('#wake-rate').select_option('2')


def verify(site, url, preview):
    context = site.new_context(viewport={"width": 1600, "height": 1000})
    errors, external = [], []
    origin = urlsplit(url).netloc

    def local(route):
        dest = urlsplit(route.request.url)
        if dest.scheme in ('http', 'https') and dest.netloc != origin:
            external.append(dest.netloc)
            route.abort()
        else:
            route.continue_()

    context.route('**/*', local)
    p = context.new_page()
    frames = watch_wake_geometry(context, p, url)
    geometry_requests = []
    p.on('request', lambda request: geometry_requests.append(request.url)
         if '/data/frames/' in request.url and urlsplit(request.url).path.endswith('.glb') else None)
    p.on('pageerror', lambda error: errors.append(str(error)))
    p.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
    p.goto(url, wait_until='domcontentloaded')
    expect(p.locator('#source-tag')).to_have_text('真实 CFD', timeout=60000)
    check_autoplay(p, frames)
    expect(p.locator('#slice-caption')).to_contain_text('Z 32', timeout=45000)
    if preview:
        set_range(p, '#physical-time', 0)
        expect(p.locator('#physical-clock')).to_have_text('0.00 s')
        preview.parent.mkdir(parents=True, exist_ok=True)
        p.screenshot(path=preview)
    set_range(p, '#physical-time', 50.04)
    expect(p.locator('#stage-tag')).to_have_attribute('data-step','835')
    p.locator('#streamlines').check()
    expect(p.locator('#stream-note')).to_be_visible()
    p.locator('#streamlines').uncheck()

    measured = p.locator('#canvas-shell canvas')
    before = measured.screenshot()
    bounds = measured.bounding_box()
    x = bounds['x'] + bounds['width'] / 2
    y = bounds['y'] + bounds['height'] / 2
    p.mouse.move(x, y)
    p.mouse.down()
    p.mouse.move(x + 95, y + 22, steps=6)
    p.mouse.up()
    assert before != measured.screenshot(), 'Orbit leaves the framebuffer unchanged'
    p.locator('#reset-camera').click()
    p.locator('[data-view=volume]').click()
    expect(p.locator('#loading')).to_be_hidden(timeout=30000)
    p.locator('#physical-keys [data-ch=p]').click()
    expect(p.locator('#physical-unit')).to_contain_text('Pa')
    expect(p.locator('#loading')).to_be_hidden()
    p.locator('[data-view=slice]').click()
    set_range(p, '#slice-position', 12)
    set_range(p, '#physical-time', 60)
    expect(p.locator('#source-step')).to_contain_text('1001')
    expect(p.locator('#slice-caption')).to_contain_text('60.00 s')
    p.locator('.wake-atlas button').nth(3).click()
    expect(p.locator('#physical-clock')).to_have_text('51.96 s')
    expect(p.locator('#slice-position')).to_have_value('32')
    expect(p.locator('[data-view=slice]')).to_have_attribute('aria-pressed','true')
    p.locator('#lod').select_option('4')
    expect(p.locator('#loading')).to_be_hidden()
    with TemporaryDirectory() as temp:
        with p.expect_download() as download:
            p.locator('#capture').click()
        png = Path(temp) / 'scene.png'
        download.value.save_as(png)
        assert png.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n'
    chapter(p, 1)
    p.locator('[data-process-index="3"]').click()
    expect(p.locator('.mc-reading')).to_contain_text('C256')
    set_range(p, '[data-range=coarse]', 9)
    set_range(p, '[data-range=focus-z]', 5)
    p.locator('.exhibit-action').click()
    expect(p.locator('[data-range=x]')).to_have_value('9')
    expect(p.locator('[data-range=z]')).to_have_value('5')
    set_range(p, '[data-range=y]', 3)
    set_range(p, '[data-range=channel]', 255)
    expect(p.locator('[data-activation]')).to_contain_text('[255]')
    p.get_by_text('六维旁路 b', exact=True).click()
    expect(p.locator('[data-real-b]')).to_contain_text('真实 C04', timeout=15000)
    p.locator('.exhibit-action').click()
    expect(p.locator('.mc-reading')).to_contain_text('(5, 3, 9)')
    p.locator('[data-flag=curl]').uncheck()
    expect(p.locator('[data-decoded-value]')).to_contain_text('0.5358 m/s')
    p.get_by_label('逆归一化示例通道').select_option('p')
    set_range(p, '#decoder-value', -1)
    expect(p.locator('[data-decoded-value]')).to_contain_text('-21.5708 Pa')
    chapter(p, 4)
    for i in range(4):
        p.locator(f'button[data-query="{i}"]').click()
        expect(p.locator('[data-mask]')).to_contain_text(f'（{i+1}/4 帧）')
    p.get_by_role('button', name='训练', exact=True).click()
    p.get_by_role('button', name='Regime', exact=True).click()
    expect(p.locator('[data-slot-title]')).to_contain_text('Regime')
    chapter(p, 5)
    set_range(p, '#training-tau', .25)
    expect(p.locator('[data-training-state]')).to_contain_text('= 0.40')
    expect(p.locator('[data-out=tau]')).to_have_text('0.00')
    set_range(p, '[data-range=tau]', 75)
    expect(p.locator('[data-out=tau]')).to_have_text('0.75')
    p.locator('[data-flag=shortcut]').check()
    chapter(p, 6)
    expect(p.locator('[data-frame-label]')).to_contain_text('837')
    expect(p.locator('[data-metric]')).to_contain_text('模拟预测 · 切片 RMSE', timeout=15000)
    set_range(p, '[data-range=k]', 1)
    expect(p.locator('[data-metric]')).to_contain_text('缺少独立真值', timeout=15000)
    expect(p.locator('[data-compare="1"]')).to_be_disabled()
    p.get_by_role('button', name='H = 100', exact=True).click()
    set_range(p, '[data-range=k]', 100)
    expect(p.locator('[data-frame-label]')).to_contain_text('935')
    expect(p.locator('[data-fifo-example] .out')).to_contain_text('931')
    expect(p.locator('[data-fifo-example] .in')).to_contain_text('935')
    expect(p.locator('[data-ref]')).to_contain_text('56.04 s', timeout=15000)
    chapter(p, 5)
    expect(p.locator('[data-out=tau]')).to_have_text('0.00')
    # The narrated replay holds the 60 s endpoint before its two landmark revisits.
    guide=context.request.get(url+'assets/guide.json').json()
    movie_cue=next(s for s in guide['shots'] if s['id']=='wake.play')
    guide_end=(movie_cue['startFrame']+movie_cue['frames'])/guide['fps']
    set_range(p, '#master', round((guide_end-.12)/guide['duration']*8399))
    expect(p.locator('.chapter-btn[aria-current=step]')).to_have_attribute('data-nav', '0')
    expect(p.locator('#stage-tag')).to_have_attribute('data-step','1001')
    expect(p.locator('#physical-clock')).to_have_text('60.00 s')
    expect(p.locator('#cycle')).to_have_attribute('aria-pressed', 'false')
    check_film_seeks(p,url)
    chapter(p, 1)
    p.evaluate('window.wakePaints=[]')
    chapter(p, 0)
    expect_origin(p)
    p.wait_for_function("window.wakePaints.some(f=>f.step===9)")
    chapter(p, 1)
    expect(p.locator('#physical-time')).to_have_count(0)
    count_after_exit = p.evaluate("window.wakePaints.length")
    requests_after_exit = len(geometry_requests)
    p.wait_for_timeout(550)
    assert p.evaluate("window.wakePaints.length") == count_after_exit
    assert len(geometry_requests) == requests_after_exit, geometry_requests[requests_after_exit:]
    p.evaluate('window.wakePaints=[]')
    chapter(p, 0)
    p.wait_for_function("window.wakePaints.some(f=>f.step===9)")
    p.locator('#tour').evaluate('button=>{window.wakePaints=window.wakePaints.slice(-1); button.click()}')
    p.wait_for_function("window.wakePaints.some(f=>f.step===5) && Number(document.getElementById('master').value)>45")
    expect(p.locator('#cycle')).to_have_attribute('aria-pressed', 'false')
    assert p.evaluate("window.wakePaints.slice(1,3).map(f=>f.step)") == [1,5]
    p.locator('#play').click()
    paused = p.locator('#master').input_value()
    p.wait_for_timeout(190)
    assert paused == p.locator('#master').input_value()
    p.locator('#tour').click()
    p.locator('#resources').click()
    for link in p.locator('dialog a').all():
        response=context.request.head(link.get_attribute('href') if link.get_attribute('href').startswith('http') else url+link.get_attribute('href').removeprefix('./'))
        assert response.ok, (link.inner_text(), response.status)
    p.locator('#close-dialog').click()
    p.set_viewport_size({'width':390,'height':844})
    p.wait_for_function("document.documentElement.scrollWidth <= innerWidth + 1")
    assert not external, external
    assert not errors, errors
    context.close()
    print('PASS: seven chapters, CFD controls, camera, PNG, transport, materials, mobile width, local resources.')


def full_tour(browser, url):
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    expect(page.locator('#source-tag')).to_have_text('真实 CFD', timeout=60000)
    page.evaluate("""() => {
        window.tourChapters = [];
        window.guideWakeSteps = [];
        const note = () => {
            const active = Number(document.querySelector('.chapter-btn[aria-current=step]').dataset.nav);
            if (window.tourChapters.at(-1)!==active) window.tourChapters.push(active);
        };
        note();
        new MutationObserver(note).observe(document.querySelector('#chapters'),
            {attributes:true,subtree:true,attributeFilter:['aria-current']});
        const tag=document.querySelector('#stage-tag');
        new MutationObserver(()=>{
            if(!document.querySelector('.chapter-btn[data-nav="0"][aria-current=step]') ||
               document.querySelector('#tour').getAttribute('aria-pressed')!=='true')return;
            const step=Number(tag.dataset.step);
            if(step && window.guideWakeSteps.at(-1)!==step)window.guideWakeSteps.push(step);
        }).observe(tag,{attributes:true,attributeFilter:['data-step']});
    }""")
    page.locator('#rate').select_option('2')
    page.locator('#tour').click()
    duration=page.request.get(url+'assets/guide.json').json()['duration']
    page.wait_for_function("Number(document.querySelector('#master').value)>=8398 && document.querySelector('#play').getAttribute('aria-label')==='播放讲解'", timeout=int(duration/2*1000)+35000)
    assert page.evaluate("window.tourChapters") == list(range(7))
    steps=page.evaluate("window.guideWakeSteps")
    assert 1001 in steps and steps[-1]==867, steps
    assert int(page.locator('#master').input_value()) >= 8398
    assert not errors, errors
    page.close()
    print('PASS: entire seven-chapter tour at 2x, chapter transitions and end of playback.')


def slow_embedded_clock(browser, url):
    page = browser.new_page(viewport={"width": 1254, "height": 830})
    # Reproduce the one-second display callback observed in the visible Codex preview.
    page.add_init_script("""window.requestAnimationFrame=fn=>setTimeout(()=>fn(performance.now()),1000);
        window.cancelAnimationFrame=clearTimeout;""")
    page.add_init_script(MOTION_PIXELS)
    page.goto(url)
    page.wait_for_function("document.querySelector('#stage-tag')?.dataset.step", polling=40)
    # In this sparse region the next observation is over two physical seconds
    # away. The camera stays fixed. Only intermediate images of the 3D scene
    # may satisfy this test; an animated HTML time label cannot.
    set_range(page,'#physical-time',24)
    page.wait_for_function("document.querySelector('#stage-tag')?.dataset.step==='401'",polling=40)
    page.locator('#wake-rate').select_option('1')
    page.locator('#cycle').evaluate('button=>{window.wakeMotion.length=0;button.click()}')
    page.wait_for_function("window.wakeMotion.filter(r=>r.step===401 && r.changed>=8).length>=4",
                           polling=40, timeout=8000)
    page.locator('#cycle').evaluate('button=>button.click()')
    set_range(page, '#physical-time', 50.04)
    page.wait_for_function("document.querySelector('#stage-tag')?.dataset.step === '835'", polling=40)
    page.locator('#wake-rate').select_option('1')
    page.evaluate("""() => {
        window.seenSteps = [];
        const tag = document.querySelector('#stage-tag');
        new MutationObserver(() => window.seenSteps.push(Number(tag.dataset.step)))
            .observe(tag,{attributes:true,attributeFilter:['data-step']});
    }""")
    page.locator('#cycle').click()
    page.wait_for_function("window.seenSteps.some(step=>step>=883)", timeout=45000, polling=50)
    page.locator('#cycle').click()
    steps = page.evaluate("window.seenSteps")
    assert [step for step in dict.fromkeys(steps) if 835 < step <= 883] == list(range(837, 884, 2)), steps
    page.close()
    print('PASS: sparse samples show intermediate changes in the 3D pixels; dense samples stay ordered under 1 Hz display callbacks.')


def fallback(playwright, options, url):
    options = {**options, 'args': ['--disable-webgl']}
    browser = playwright.chromium.launch(**options)
    page = browser.new_page()
    requests = []
    page.on('request', lambda request: requests.append(urlsplit(request.url).path))
    page.add_init_script("""window.movieStarts=[];
        document.addEventListener('loadedmetadata',e=>{
          if(e.target instanceof HTMLVideoElement)window.movieStarts.push(e.target.currentTime);
        }, true);""")
    page.goto(url)
    video = page.locator('video:visible')
    expect(page.locator('#wake-rate')).to_have_value('compact')
    page.wait_for_function("""() => {
        const v = [...document.querySelectorAll('video')].find(v=>v.getBoundingClientRect().width);
        return v?.currentTime>0 && !v.paused;
    }""", timeout=30000)
    assert any(path.endswith(('/wake-compact.mp4','/wake-compact-120.mp4')) for path in requests), requests
    assert page.evaluate('window.movieStarts[0]') < .1
    assert abs(video.evaluate('v=>v.duration') - 8) <= .15
    assert video.evaluate('v=>v.playbackRate') == 1
    expect(page.locator('#cycle')).to_have_attribute('aria-pressed', 'false', timeout=45000)
    expect(page.locator('#physical-clock')).to_have_text('60.00 s')
    expect(page.locator('#master')).to_have_value('0')
    page.locator('#cycle').click()
    page.wait_for_function("Number(document.querySelector('#physical-time').value)>0 && Number(document.querySelector('#physical-time').value)<5")
    set_range(page,'#physical-time',30)
    expect(page.locator('#physical-clock')).to_have_text('30.00 s')
    page.locator('#wake-rate').select_option('4')
    page.wait_for_function("""() => {
        const v=document.querySelector('#canvas-shell video');
        return v?.duration>59 && v.duration<61 && Math.abs(v.currentTime-30)<.15 && v.playbackRate===4;
    }""")
    assert any(path.endswith('/wake-0-60.mp4') for path in requests), requests
    expect(page.locator('#cycle')).to_have_attribute('aria-pressed','false')
    page.locator('#cycle').click()
    expect(page.locator('#physical-clock')).to_have_text('60.00 s',timeout=20000)
    chapter(page, 5)
    expect(page.locator('[data-out=tau]')).to_have_text('0.00')
    for _ in range(8):
        page.locator('[data-integrate="1"]').click()
    expect(page.locator('[data-out=tau]')).to_have_text('1.00')
    expect(page.locator('[data-integrate="1"]')).to_be_disabled()
    # Native 2D comparison and FIFO also work when the GPU is unavailable.
    chapter(page, 6)
    expect(page.locator('[data-model-capture]')).to_be_visible()
    expect(page.locator('.model-controls')).to_have_attribute('data-output', 'simulated', timeout=15000)
    page.locator('[data-process-index="3"]').click()
    expect(page.locator('[data-process-index="3"]')).to_have_attribute('aria-pressed','true')
    expect(page.locator('[data-ref]')).to_contain_text('50.16 s', timeout=15000)
    expect(page.locator('[data-metric]')).to_contain_text('RMSE')
    page.locator('button[data-compare="1"]').click()
    expect(page.locator('.model-controls')).to_have_attribute('data-comparison','error')
    set_range(page,'[data-range=k]',1)
    expect(page.locator('[data-ref]')).to_contain_text('前一归档')
    expect(page.locator('[data-metric]')).to_contain_text('缺少')
    expect(page.locator('button[data-compare="1"]')).to_be_disabled()
    check_film_seeks(page,url,native_only=True)
    print('PASS: offline video autoplays the whole wake, replays and seeks independently of the guide.')
    browser.close()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8765/')
    parser.add_argument('--browser', help='Installed Chrome / Edge executable')
    parser.add_argument('--preview', type=Path)
    parser.add_argument('--software', action='store_true', help='Use SwiftShader for headless WebGL2')
    parser.add_argument('--full-tour', action='store_true', help='Play the complete seven-chapter narration at 2x.')
    arguments=parser.parse_args()
    options={'headless':True}
    if arguments.browser:
        options['executable_path']=arguments.browser
    if arguments.software:
        options['args']=['--use-angle=swiftshader','--enable-unsafe-swiftshader']
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(**options)
        try:
            verify(browser, arguments.url.rstrip('/')+'/', arguments.preview)
            if arguments.full_tour:
                full_tour(browser, arguments.url)
                slow_embedded_clock(browser, arguments.url)
        finally:
            browser.close()
        fallback(playwright, options, arguments.url)

