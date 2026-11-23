"""Check the interactive Flow Matching example in a running offline FlowScope build."""
import argparse
from io import BytesIO
from math import cos, isclose, pi, sin
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urldefrag, urljoin, urlsplit

from PIL import Image, ImageChops
from playwright.sync_api import expect, sync_playwright

from check_viewer import chapter, set_range


def assert_number(shown, expected):
    assert isclose(shown, expected, abs_tol=0.00011), (shown, expected)


def visible_number(page, selector):
    field = page.locator(selector)
    expect(field).to_be_visible()
    return float(field.inner_text().strip().replace('−', '-'))


def velocity(state, tau, condition_step=0):
    return [
        1 - .5 * state[0] + .25 * tau + .16 * condition_step,
        1.7 * cos(2 * pi * tau) - .35 * state[1] - .12 * condition_step,
        1.1 * sin(2 * pi * tau) - .25 * state[2] + .10 * condition_step,
    ]


def check_euler(page):
    tau = page.locator('[data-out=tau]')
    back = page.locator('[data-integrate="0"]')
    advance = page.locator('[data-integrate="1"]')
    master_start = page.locator('#master').input_value()
    expect(tau).to_have_text('0.00')
    for feature in range(3):
        page.locator(f'[data-fm-feature="{feature}"]').click()
        set_range(page, '[data-range=tau]', 0)
        reference = [.2, -.12, .1]
        for step in range(8):
            # Compare the visible readings against a separate integration from
            # the initial state so an erroneous velocity cannot validate itself.
            v = velocity(reference, step / 8)
            next_reference = [initial + slope / 8 for initial, slope in zip(reference, v)]
            for key, expected in [('current', reference[feature]), ('velocity', v[feature]),
                                  ('delta', v[feature] / 8), ('next', next_reference[feature])]:
                assert_number(visible_number(page, f'[data-fm-value="{key}"]'), expected)
            reference = next_reference
            advance.click()
        expect(tau).to_have_text('1.00')
        assert_number(visible_number(page, '[data-fm-value="next"]'), reference[feature])
        expect(advance).to_be_disabled()
        back.click()
        assert isclose(float(tau.inner_text()), .875, abs_tol=.0051)
    assert page.locator('#master').input_value() == master_start
    page.locator('[data-fm-feature="0"]').click()
    set_range(page, '[data-range=tau]', 0)
    expect(back).to_be_disabled()
    # Scrubbing within the first interval keeps its left-end evaluation;
    # the readout gives the full Euler step, including its right endpoint.
    set_range(page, '[data-range=tau]', 6)
    expect(tau).to_have_text('0.06')
    assert_number(visible_number(page, '[data-fm-value="current"]'), .2)
    assert_number(visible_number(page, '[data-fm-value="next"]'), .3125)
    set_range(page, '[data-range=tau]', 50)
    expect(tau).to_have_text('0.50')
    assert_number(visible_number(page, '[data-fm-value="current"]'), .63201904296875)
    set_range(page, '[data-range=tau]', 75)
    expect(tau).to_have_text('0.75')
    set_range(page, '[data-range=tau]', 77)
    expect(tau).to_have_text('0.77')
    assert page.locator('#master').input_value() == master_start


def check_shortcut(page):
    state = [.2, -.12, .1]
    first = velocity(state, 0, .125)
    midpoint = [initial + slope * .125 for initial, slope in zip(state, first)]
    second = velocity(midpoint, .125, .125)
    student = velocity(state, 0, .25)
    shortcut = page.locator('[data-flag=shortcut]')
    shortcut.check()
    expect(page.locator('[data-fm-shortcut]')).to_be_visible()
    for feature in range(3):
        page.locator(f'[data-fm-feature="{feature}"]').click()
        target = (first[feature] + second[feature]) / 2
        for key, expected in [('half1', first[feature]), ('half2', second[feature]),
                              ('target', target), ('student', student[feature])]:
            assert_number(visible_number(page, f'[data-fm-short="{key}"]'), expected)
    shortcut.uncheck()


def check_training_sample(page):
    inference_time = page.locator('[data-out=tau]').inner_text()
    guide_time = page.locator('#master').input_value()
    for tau, expected in [(0, '0.20'), (.5, '0.60'), (1, '1.00')]:
        set_range(page, '#training-tau', tau)
        text = page.locator('[data-training-state]').inner_text()
        assert text.rsplit('=', 1)[1].strip() == expected, text
        expect(page.locator('[data-out=tau]')).to_have_text(inference_time)
        assert page.locator('#master').input_value() == guide_time
    expression = page.locator('[data-phase-expression]')
    for phase in range(4):
        page.locator(f'[data-fm-phase="{phase}"]').click()
        if phase == 0:
            expect(expression).to_contain_text(page.locator('[data-fm-value="current"]').inner_text())
        elif phase == 1:
            expect(page.locator('[data-phase-reading]')).to_contain_text('四帧')
        elif phase == 2:
            expect(expression).to_contain_text(page.locator('[data-fm-value="velocity"]').inner_text())
        else:
            expect(expression).to_have_text(page.locator('[data-fm-equation]').inner_text())
            page.locator('[data-fm-feature="2"]').click()
            expect(expression).to_have_text(page.locator('[data-fm-equation]').inner_text())


def check_related_examples(page, url):
    manifest = page.request.get(urljoin(url, 'data/manifest.json')).json()
    frame = manifest['frames'][manifest.get('modelReferenceFrame', manifest['defaultFrame'])]
    chapter(page, 3)
    expect(page.locator('[data-stats-source]')).to_contain_text(f"{frame['time_s']:.2f} s")
    select = page.get_by_role('combobox', name='逆归一化示例通道')
    for index, field in enumerate('uvwp'):
        select.select_option(field)
        set_range(page, '#decoder-value', '-1.5')
        mean = frame['stats6'][index]
        scale = frame['stats6'][5 if field == 'p' else 4]
        result = page.locator('[data-decoded-value]').inner_text().split('≈')[1].split()
        assert_number(float(result[0]), mean - 1.5 * scale)
        assert result[1] == manifest['units'][field]

    chapter(page, 6)
    set_range(page, '[data-range=k]', 10)
    expected = frame['step'] + 10
    expect(page.locator('[data-fifo-target]')).to_contain_text(str(expected))
    cells = [int(t) for t in page.locator('[data-fifo-example] .window-cell b').all_text_contents()]
    assert cells == [*range(expected-4, expected), *range(expected-3, expected+1)], cells
    target = next(row for row in manifest['frames'] if row['step'] == expected)
    expect(page.locator('[data-rollout-clock]')).to_contain_text(f"{target['time_s']:.2f} s")


def check_visual(page):
    canvas = page.locator('#canvas-shell canvas')
    before = Image.open(BytesIO(canvas.screenshot())).convert('RGB')
    bounds = canvas.bounding_box()
    x, y = bounds['x'] + bounds['width'] / 2, bounds['y'] + bounds['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 110, y - 35, steps=10)
    page.mouse.up()
    after = Image.open(BytesIO(canvas.screenshot())).convert('RGB')
    assert ImageChops.difference(before, after).getbbox(), 'Dragging the FM camera left the scene unchanged'
    page.locator('#reset-camera').click()
    with TemporaryDirectory() as temp:
        with page.expect_download() as action:
            page.locator('#capture').click()
        download = action.value
        assert download.suggested_filename.endswith('fm.png')
        file = Path(temp) / 'fm.png'
        download.save_as(file)
        with Image.open(file) as export:
            width, height = canvas.evaluate('c => [c.width,c.height]')
            assert export.format == 'PNG' and export.width == width and export.height >= height
            # Different colours in the central scene exclude a blank exported canvas.
            sample = export.crop((0, 0, width, height)).convert('RGB')
            assert min(high - low for low, high in sample.getextrema()) > 30


def check(browser, url):
    context = browser.new_context(viewport={'width': 1600, 'height': 1000})
    errors = []
    origin = urlsplit(url).netloc

    def local(route):
        target = urlsplit(route.request.url)
        if target.scheme in ('http', 'https') and target.netloc != origin:
            errors.append(f'Unexpected external dependency: {target.netloc}')
            route.abort()
        else:
            route.continue_()

    context.route('**/*', local)
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda entry: errors.append(entry.text) if entry.type == 'error' else None)
    page.goto(urldefrag(url).url + '#fm', wait_until='domcontentloaded')
    expect(page.locator('.chapter-btn[aria-current=step]')).to_have_attribute('data-nav', '5')
    expect(page.locator('#source-tag')).to_contain_text('合成')
    check_euler(page)
    check_training_sample(page)
    check_shortcut(page)
    shortcut = page.locator('[data-flag=shortcut]')
    check_visual(page)
    shortcut.check()
    chapter(page, 4)
    chapter(page, 5)
    expect(shortcut).not_to_be_checked()
    expect(page.locator('[data-out=tau]')).to_have_text('0.00')
    timeline=context.request.get(url+'assets/guide.json').json()
    cue=next(s for s in timeline['shots'] if s['id']=='fm.step1')
    update_time=(cue['startFrame']+cue['frames']-50)/timeline['fps']
    set_range(page,'#master',round(update_time/timeline['duration']*8399))
    page.locator('#play').click()
    page.wait_for_function("Number(document.querySelector('[data-out=tau]').textContent) > .03")
    page.locator('#play').click()
    paused = page.locator('[data-out=tau]').inner_text()
    page.wait_for_timeout(200)
    expect(page.locator('[data-out=tau]')).to_have_text(paused)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_function("document.documentElement.scrollWidth <= innerWidth + 1")
    page.locator('[data-fm-feature="2"]').click()
    set_range(page, '[data-range=tau]', 50)
    expect(page.locator('[data-out=tau]')).to_have_text('0.50')
    check_related_examples(page, url)
    assert not errors, errors
    context.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8765/')
    edge = Path(os.environ.get('ProgramFiles(x86)', '')) / 'Microsoft/Edge/Application/msedge.exe'
    parser.add_argument('--browser', default=str(edge) if edge.is_file() else None)
    parser.add_argument('--software', action='store_true', help='Select SwiftShader for headless WebGL2')
    args = parser.parse_args()
    with sync_playwright() as host:
        flags = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] if args.software else []
        browser = host.chromium.launch(executable_path=args.browser, args=flags)
        try:
            check(browser, args.url)
        finally:
            browser.close()
    print('PASS: FM Euler steps, Shortcut, training sample, camera, PNG, tour, mobile, decoded physical units and FIFO.')
