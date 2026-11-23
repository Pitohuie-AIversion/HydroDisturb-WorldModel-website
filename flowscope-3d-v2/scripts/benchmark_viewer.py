"""Measure an offline FlowScope build in desktop Chromium via Playwright.

Use the same GPU, window dimensions and duration for comparisons. WebGL
statistics measure draw submission on animation frames, not monitor scanout.
Q playback identifies the actual indexed geometry submitted by matching its
index count to the precomputed archive, independent of the page's time label.
"""
import argparse
import json
import math
import os
import statistics
import struct
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
EDGE = Path(os.environ.get('ProgramFiles(x86)', '')) / 'Microsoft/Edge/Application/msedge.exe'
INSTRUMENT = """
(() => {
  const rows = {refresh: [], renders: [], tasks: []};
  let stamp = -1, pendingTask;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = fn => raf(t => {
    stamp = t;
    try { fn(t); } finally { stamp = -1; }
  });
  function refresh(t) { rows.refresh.push(t); raf(refresh); }
  raf(refresh);
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const original = WebGL2RenderingContext.prototype[name];
    WebGL2RenderingContext.prototype[name] = function(...args) {
      {
        let row = stamp >= 0 ? rows.renders.at(-1) : pendingTask;
        if (!row || (stamp>=0 && row.t!==stamp)) {
          const submitted=performance.now();
          row = {t:stamp>=0?stamp:submitted, source:stamp>=0?'raf':'task', submitted, calls:0, largestIndexed:0};
          rows.renders.push(row);
          if (stamp<0) {
            pendingTask=row;
            queueMicrotask(()=>{pendingTask=undefined;});
          }
        }
        row.calls++;
        if (name === 'drawElements' && args[0] === this.TRIANGLES && args[1]>row.largestIndexed) {
          row.largestIndexed = args[1];
          if (args[1]>3000 && document.getElementById('physical-clock')) {
            const tag = document.getElementById('stage-tag');
            const label = document.getElementById('source-step');
            queueMicrotask(()=>{
              row.step = Number(tag?.dataset.step || (label?.textContent || '').split('/')[0]);
            });
          }
        }
      }
      return original.apply(this, args);
    };
  }
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    new PerformanceObserver(l => {
      for(const task of l.getEntries()) rows.tasks.push([task.startTime,task.duration]);
    }).observe({type:'longtask',buffered:true});
  }
  window.bench = rows;
})();
"""


def geometry_counts(data):
    """Use only GLB JSON headers. Reading the binary payload would warm the OS cache."""
    manifest = json.loads((data / 'manifest.json').read_bytes())
    counts = {}
    for frame in manifest['frames']:
        for lod in ('structure', 'structureLow'):
            asset = frame['assets'].get(lod)
            if not asset:
                continue
            with (data / asset['path']).open('rb') as stream:
                header = stream.read(20)
                size = struct.unpack_from('<I', header, 12)[0]
                gltf = json.loads(stream.read(size))
            count = max(gltf['accessors'][primitive['indices']]['count']
                        for mesh in gltf['meshes'] for primitive in mesh['primitives'])
            counts.setdefault(count, set()).add(frame['step'])
    return counts, manifest['frames'][manifest['defaultFrame']]['step']


def intervals(times):
    gaps = [b - a for a, b in zip(times, times[1:])]
    if not gaps:
        return {}
    ordered = sorted(gaps)
    p95 = ordered[math.ceil(len(gaps)*.95)-1]
    return {'median_ms': round(statistics.median(gaps), 1), 'p95_ms': round(p95, 1),
            'max_ms': round(max(gaps), 1), 'over_50ms': sum(x > 50 for x in gaps)}


def snapshot(page, begin, end, counts, *, q_scene=False):
    data = page.evaluate("""([a,b]) => ({
      refresh:bench.refresh.filter(t=>t>=a && t<=b),
      renders:bench.renders.filter(r=>r.t>=a && r.t<=b),
      tasks:bench.tasks.filter(([t,d])=>t<b && t+d>a)
    })""", [begin, end])
    tiles = data['renders']
    duration = end - begin
    result = {'duration_ms': round(duration), 'raf': intervals(data['refresh']),
              'webgl_frames': len(tiles), 'webgl_fps': round(len(tiles)*1000/duration, 1),
              'draw_interval': intervals([r['t'] for r in tiles]),
              'long_tasks': len(data['tasks']),
              'longest_task_ms': round(max((d for _, d in data['tasks']), default=0))}
    if tiles:
        result['median_draw_calls'] = statistics.median(r['calls'] for r in tiles)
    result['timer_or_other_draw_frames'] = sum(row['source']=='task' for row in tiles)
    result['framebuffer'] = page.locator('#canvas-shell canvas').evaluate('c=>[c.width,c.height]')
    if q_scene:
        changes = []
        for row in tiles:
            matches = counts.get(row['largestIndexed'], set())
            if row.get('step') in matches:
                matches = {row['step']}
            if matches and (not changes or changes[-1][1] != sorted(matches)):
                changes.append((row['t'], sorted(matches)))
        result['q_steps_drawn'] = [steps if len(steps)>1 else steps[0] for _, steps in changes]
        result['q_capture_interval'] = intervals([t for t,_ in changes])
        result['q_captures_per_s'] = round(len(changes)*1000/duration, 1)
    return result


MOTION_PIXELS = """
(() => {
  const copy=document.createElement('canvas');
  copy.width=160; copy.height=80;
  const ctx=copy.getContext('2d',{willReadFrequently:true});
  let previous,queued=false;
  window.wakeMotion=[];
  for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
    const original=WebGL2RenderingContext.prototype[name];
    WebGL2RenderingContext.prototype[name]=function(...args){
      const result=original.apply(this,args);
      if(queued || this.canvas.parentElement?.id!=='canvas-shell')return result;
      queued=true;
      queueMicrotask(()=>{
        queued=false;
        const step=Number(document.querySelector('#stage-tag')?.dataset.step);
        if(!step)return;
        // HTML clocks and labels are outside the 3D drawing buffer.
        ctx.clearRect(0,0,copy.width,copy.height);
        ctx.drawImage(this.canvas,0,0,copy.width,copy.height);
        const pixels=ctx.getImageData(0,0,copy.width,copy.height).data;
        let changed=0,visible=0;
        for(let i=0;i<pixels.length;i+=4){
          if(pixels[i+3]>8)visible++;
          if(previous && Math.abs(previous[i]-pixels[i])+Math.abs(previous[i+1]-pixels[i+1])+
            Math.abs(previous[i+2]-pixels[i+2])+Math.abs(previous[i+3]-pixels[i+3])>=4)changed++;
        }
        window.wakeMotion.push({t:performance.now(),step,changed,visible});
        previous=pixels;
      });
      return result;
    };
  }
})();
"""


def measure_wake_motion(opts, chromium):
    flags=['--use-angle=swiftshader','--enable-unsafe-swiftshader'] if opts.software else []
    browser=chromium.launch(executable_path=opts.browser,headless=not opts.headed,args=flags)
    page=browser.new_page(viewport={'width':1600,'height':1000})
    errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    page.add_init_script(MOTION_PIXELS)
    page.goto(opts.url,wait_until='domcontentloaded')
    page.wait_for_function("window.wakeMotion.some(x=>x.step===1001)",timeout=120000)
    rate=page.locator('#wake-rate').input_value()
    rows=page.evaluate('window.wakeMotion')
    frames=json.loads((opts.data/'manifest.json').read_bytes())['frames']
    expected=[f['step'] for f in frames]
    first={}
    for row in rows:
        first.setdefault(row['step'],row['t'])
    assert list(first)==expected,(list(first),expected)
    assert min(r['visible'] for r in rows)>25
    assert not errors,errors
    gl_info=page.evaluate("""() => {
      const canvas=document.querySelector('#canvas-shell canvas'), gl=canvas.getContext('webgl2');
      const info=gl.getExtension('WEBGL_debug_renderer_info');
      return [info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
              canvas.width,canvas.height];
    }""")
    info={'url':opts.url,'bundle':page.locator('script[type=module][src]:not([src*="@vite"])').get_attribute('src'),
          'browser':browser.version,'renderer':gl_info[0],'framebuffer':gl_info[1:],
          'selected_rate':rate,'archive_count':len(first),
          'archive_interval':intervals(list(first.values())),
          'elapsed_seconds':round((first[expected[-1]]-first[expected[0]])/1000,3),
          'method':'Fixed camera. Downsample each WebGL submission to 160x80. Count an image change if at least 8 pixels differ by a total of 4 RGBA values from their preceding draw. Readback can slow rendering; these are changes to drawing-buffer content.',
          'windows':{}}
    for left,right in ((0,60),(20.04,50.04),(50.04,53.04)):
        segment=[f['step'] for f in frames if left-1e-6<=f['time_s']<=right+1e-6]
        start,end=first[segment[0]],first[segment[-1]]
        view=[r for r in rows if start<=r['t']<=end]
        changed_rows=[r for r in view[1:] if r['changed']>=8]
        changes=[r['t'] for r in changed_rows]
        middle=[r for i,r in enumerate(view) if i and r['step']==view[i-1]['step'] and r['changed']>=8]
        anchors=[view[0],*changed_rows]
        if anchors[-1]!=view[-1]:
            anchors.append(view[-1])
        largest=sorted(((b['t']-a['t'],a['step'],b['step']) for a,b in zip(anchors,anchors[1:])),reverse=True)[:3]
        info['windows'][f'{left:g}-{right:g}s']={
            'seconds':round((end-start)/1000,3),'draws':len(view),'changed_images':len(changes),
            'changes_per_wall_second':round(len(changes)*1000/(end-start),2),
            'changed_within_same_archive_step':len(middle),
            'change_intervals':intervals([start,*changes]+([end] if not changes or changes[-1]<end else [])),
            'longest_changes_ms_from_step_to_step':[[round(dt,1),a,b] for dt,a,b in largest],
        }
    browser.close()
    return info


def now(page):
    return page.evaluate('performance.now()')


class Compositor:
    """Count Chromium presentation feedback for this renderer, deduplicated by timestamp."""
    def __init__(self, browser, enabled):
        self.client = browser.new_browser_cdp_session() if enabled else None
        self.events = []
        self.done = False
        if self.client:
            self.client.on('Tracing.dataCollected', self.collect)
            self.client.on('Tracing.tracingComplete', self.complete)

    def collect(self, message):
        self.events.extend(e for e in message['value']
                           if e['name'] in ('PipelineReporter','flowscope.trace.anchor'))

    def complete(self, _):
        self.done = True

    def start(self, page):
        if not self.client:
            return
        self.events.clear()
        self.done = False
        self.client.send('Tracing.start',{'categories':'benchmark,blink.user_timing','transferMode':'ReportEvents'})
        page.evaluate("performance.mark('flowscope.trace.anchor')")

    def finish(self, page, start, end):
        if not self.client:
            return {}
        self.client.send('Tracing.end')
        deadline = time.monotonic()+15
        while not self.done and time.monotonic()<deadline:
            page.wait_for_timeout(20)
        if not self.done:
            raise RuntimeError('Chromium compositor trace did not finish')
        anchor = next(e for e in self.events if e['name']=='flowscope.trace.anchor')
        offset = anchor['ts']/1000-anchor['args']['data']['startTime']
        reports = sorted((e for e in self.events if e['name']=='PipelineReporter' and e['pid']==anchor['pid']),
                         key=lambda e:(e['ts'],e['ph']=='b'))
        pending, presented = {}, set()
        for event in reports:
            token = (event['tid'],event.get('id2',{}).get('local'))
            if event['ph']=='b':
                pending[token] = event.get('args',{}).get('frame_reporter',{}).get('state','')
            elif event['ph']=='e' and pending.pop(token,'').startswith('STATE_PRESENTED'):
                t = event['ts']/1000-offset
                presented.add(t)
        self.feedback = sorted(presented)
        return self.feedback_for(start,end)

    def feedback_for(self,start,end):
        if not self.client:
            return {}
        presented = [t for t in self.feedback if start<=t<=end]
        return {'compositor_presented_frames':len(presented),
                'compositor_feedback_fps':round(len(presented)*1000/(end-start),1),
                'compositor_feedback_interval':intervals(presented)}


def drag(page, seconds):
    bounds = page.locator('#canvas-shell canvas').bounding_box()
    x, y = bounds['x'] + bounds['width']*.49, bounds['y'] + bounds['height']*.45
    page.mouse.move(x, y)
    page.mouse.down()
    start = time.perf_counter()
    n = 0
    while (t := time.perf_counter()-start) < seconds:
        page.mouse.move(x+95*math.sin(t*3), y+28*math.sin(t*2.4))
        n += 1
        time.sleep(max(0, start+n/75-time.perf_counter()))
    page.mouse.up()
    return n


def render_after_click(page, selector, ready):
    button = page.locator(selector)
    button.evaluate("""e=>e.addEventListener('click',()=>{window.benchClick=performance.now()},{capture:true,once:true})""")
    button.click()
    page.wait_for_function(ready, timeout=45000)
    before = page.evaluate('benchClick')
    page.wait_for_function('t => bench.renders.some(r => r.submitted >= t)', arg=before, timeout=45000)
    return round(page.evaluate('t => bench.renders.find(r=>r.submitted>=t).submitted-t', before))


def run(opts, chromium):
    counts, _ = geometry_counts(opts.data)
    archive_by_count = {str(count): sorted(steps) for count,steps in counts.items()}
    first_q = 'a=>bench.renders.find(r=>a[r.largestIndexed]?.includes(r.step))'
    flags = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] if opts.software else []
    browser = chromium.launch(executable_path=opts.browser, headless=not opts.headed, args=flags)
    context = browser.new_context(viewport={'width':1920, 'height':1080}, device_scale_factor=1)
    page = context.new_page()
    compositor = Compositor(browser, opts.headed)
    page.set_default_timeout(45000)
    page.add_init_script(INSTRUMENT)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(opts.url, wait_until='domcontentloaded')
    first_draw = page.wait_for_function(first_q, arg=archive_by_count).json_value()
    initial_step = first_draw['step']
    ready_counts = [n for n, steps in counts.items() if initial_step in steps]
    mature_counts = [n for n, steps in counts.items() if 835 in steps]
    page.wait_for_function("document.querySelector('#slice-caption')?.textContent.includes('Z 32')")
    gpu = page.evaluate("""() => {
      const g=document.querySelector('#canvas-shell canvas').getContext('webgl2');
      const info=g.getExtension('WEBGL_debug_renderer_info');
      return {renderer:info?g.getParameter(info.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER),
        drawing_buffer:[g.drawingBufferWidth,g.drawingBufferHeight]};
    }""")
    report = {'utc':datetime.now(timezone.utc).isoformat(), 'browser':browser.version,
              'url':opts.url, 'window':[1920,1080], 'headless':not opts.headed, **gpu,
              'bundle':page.evaluate("document.querySelector('script[type=module]').src.split('/').pop()"),
              'initial_q_step':initial_step,'cold_first_q_draw_ms':round(first_draw['t']), 'cases':{}, 'first_draw_after_chapter_click_ms':{},
              'method':'WebGL submissions grouped by animation callback or synchronous draw task. Q steps match source GLB triangle index count. A static scene redraws only when needed.'}
    wake_rate = page.locator('#wake-rate')
    if wake_rate.count():
        value=wake_rate.input_value()
        report['initial_physical_rate'] = value if value=='compact' else float(value)
        report['benchmark_physical_rate'] = 1
        wake_rate.select_option('1')

    def record(name, action, q=False):
        compositor.start(page)
        begin = now(page)
        result = action()
        end = now(page)
        item = snapshot(page, begin, end, counts, q_scene=q)
        item.update(compositor.finish(page,begin,end))
        if isinstance(result,int):
            item['pointer_moves'] = result
        report['cases'][name] = item
        print(name, json.dumps(item, ensure_ascii=False), flush=True)

    def guided(name, q=False):
        page.locator('#tour').click()
        record(name, lambda: page.wait_for_timeout(int(opts.seconds*1000)), q)
        page.locator('#tour').click()

    def select_mature_q():
        # Preserve the established camera and dense-playback workload when
        # the exhibition opens at t=0. Old index-based sliders use index 51.
        physical_time = page.locator('#physical-time')
        physical_time.fill('50.04' if float(physical_time.get_attribute('max'))==60 else '51')
        page.wait_for_function("""c=>{
            const last=bench.renders.at(-1);
            return document.querySelector('#physical-clock').textContent.includes('50.04')
                && last?.step===835 && c.includes(last.largestIndexed);
        }""",arg=mature_counts)

    select_mature_q()
    page.locator('#fullscreen').click()
    page.wait_for_function('document.fullscreenElement !== null')
    page.wait_for_timeout(250)
    record('fullscreen_q_orbit', lambda: drag(page, opts.seconds), True)
    page.evaluate('document.exitFullscreen()')
    page.wait_for_timeout(200)
    page.locator('#reset-camera').click()
    start_play = page.locator('#cycle')
    compositor.start(page)
    start_play.evaluate("""e=>e.addEventListener('click',()=>{window.benchPlay=performance.now()},{capture:true,once:true})""")
    start_play.click()
    begin = page.evaluate('benchPlay')
    dense_counts = [n for n, steps in counts.items() if any(883<=s<=901 for s in steps)]
    probe = """([start,c])=>bench.renders.find(r=>r.submitted>=start && c.includes(r.largestIndexed) && r.step>=883 && r.step<=901)"""
    page.wait_for_function(probe, arg=[begin,dense_counts], timeout=45000)
    last = page.evaluate(probe,[begin,dense_counts])
    dense = snapshot(page,begin,last['t']+.1,counts,q_scene=True)
    dense['initial_step'] = 835
    dense['end_step'] = last['step']
    dense['wall_to_end_ms'] = round(last['submitted']-begin)
    report['cases']['q_dense_50.04_to_52.92s'] = dense
    print('q_dense_50.04_to_52.92s',json.dumps(dense,ensure_ascii=False),flush=True)
    end = begin+opts.playback_seconds*1000
    page.wait_for_timeout(max(0,round(end-now(page))))
    report['cases']['q_temporal_playback'] = snapshot(page,begin,end,counts,q_scene=True)
    report['cases']['q_temporal_playback'].update(compositor.finish(page,begin,end))
    dense.update(compositor.feedback_for(begin,last['t']+.1))
    if start_play.get_attribute('aria-pressed') != 'false':
        start_play.click()
    if opts.fullscreen_chapters:
        select_mature_q()
        page.locator('[data-view=volume]').click()
        page.wait_for_function("document.querySelector('#loading').hidden")
        page.locator('#fullscreen').click()
        page.wait_for_function('document.fullscreenElement !== null')
        page.wait_for_timeout(160)
        record('fullscreen_volume_orbit', lambda: drag(page, opts.seconds))
        page.evaluate('document.exitFullscreen()')
        for index in range(1,7):
            page.locator(f'.chapter-btn[data-nav="{index}"]').click()
            page.locator('#fullscreen').click()
            page.wait_for_function('document.fullscreenElement !== null')
            page.wait_for_timeout(120)
            record(f'fullscreen_chapter_{index+1}_orbit', lambda: drag(page, opts.seconds))
            page.evaluate('document.exitFullscreen()')
        report['javascript_errors'] = errors
        browser.close()
        return report
    if opts.playback_only:
        report['javascript_errors'] = errors
        browser.close()
        return report
    # Return each run to the same archive sample before testing volume/stream rendering.
    select_mature_q()
    page.locator('#streamlines').check()
    page.wait_for_timeout(600)
    page.locator('#fullscreen').click()
    page.wait_for_function('document.fullscreenElement !== null')
    record('fullscreen_q_streams', lambda: page.wait_for_timeout(int(opts.seconds*1000)), True)
    page.evaluate('document.exitFullscreen()')
    page.locator('#streamlines').uncheck()
    page.locator('[data-view=volume]').click()
    page.wait_for_function("document.querySelector('#loading').hidden")
    page.wait_for_timeout(180)
    page.locator('#fullscreen').click()
    page.wait_for_function('document.fullscreenElement !== null')
    record('fullscreen_volume_orbit', lambda: drag(page, opts.seconds))
    page.evaluate('document.exitFullscreen()')
    page.locator('[data-view=slice]').click()
    page.wait_for_function("document.querySelector('#loading').hidden")
    record('slice_orbit', lambda: drag(page, opts.seconds))
    for index in range(1,7):
        selector = f'.chapter-btn[data-nav="{index}"]'
        ready = f"document.querySelector('{selector}').getAttribute('aria-current')==='step'"
        report['first_draw_after_chapter_click_ms'][str(index+1)] = render_after_click(page, selector, ready)
        page.wait_for_timeout(150)
        record(f'chapter_{index+1}_orbit', lambda: drag(page, opts.seconds))
        if index in (2, 5, 6):
            guided(f'chapter_{index+1}_guided')
    chapter_entry = now(page)
    page.locator('.chapter-btn[data-nav="0"]').click()
    page.wait_for_function('([t,step,c])=>bench.renders.some(r=>r.t>=t && r.step===step && c.includes(r.largestIndexed))',
                           arg=[chapter_entry, initial_step, ready_counts])
    guided('q_guided',True)
    page.locator('.chapter-btn[data-nav="0"]').click()
    page.reload(wait_until='domcontentloaded')
    warm=page.wait_for_function(first_q,arg=archive_by_count).json_value()
    assert warm['step']==initial_step
    report['warm_reload_first_q_draw_ms'] = round(warm['t'])
    report['javascript_errors'] = errors
    browser.close()
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8765/')
    parser.add_argument('--browser',default=str(EDGE) if EDGE.exists() else None)
    parser.add_argument('--data',type=Path,default=ROOT/'public/data')
    parser.add_argument('--seconds',type=float,default=3)
    parser.add_argument('--playback-seconds',type=float,default=6)
    parser.add_argument('--software',action='store_true')
    parser.add_argument('--headed',action='store_true',help='Use a visible native browser window')
    parser.add_argument('--playback-only',action='store_true',help='Measure initial orbit and physical playback only')
    parser.add_argument('--wake-motion',action='store_true',help='Measure changing 3D pixels in first-chapter playback with a fixed camera')
    parser.add_argument('--fullscreen-chapters',action='store_true',help='Measure physical playback and all seven full-screen chapter orbits')
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    with sync_playwright() as session:
        report = measure_wake_motion(args, session.chromium) if args.wake_motion else run(args, session.chromium)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(args.output,flush=True)
