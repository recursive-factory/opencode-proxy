"""Non-coder control panel for the OpenCode Free-Model Proxy (Colab).

The notebook cell just downloads and execs this file. Everything is driven
by buttons: 1 Setup -> 2 Run tests -> 3 Start public address. No coding.
All user-facing wording lives in this file - keep it plain and consistent:
success lines start with a check mark, problems start with a cross and
always say what to do next.
"""
import json
import os
import re
import subprocess
import time
import urllib.request

import ipywidgets as widgets
from IPython.display import HTML, clear_output, display

ROOT = '/content/opencode-proxy'
BASE = 'http://127.0.0.1:8787'
REPO_API = 'https://api.github.com/repos/recursive-factory/opencode-proxy/contents/'
FILES = ['src/fingerprint.ts', 'src/hit-model.ts', 'src/proxy.ts',
         'src/minimize-system.ts', 'data/opencode-system.txt', 'package.json']
MODELS = ['big-pickle', 'beam-free', 'deepseek-v4.1-flash-free', 'flint-40b-free',
          'glm-5.3-flash-free', 'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free',
          'nemotron-3.5-super-vl-free']
STATE = {'proxy': None, 'tunnel': None, 'url': None, 'dump': False, 'opencode': False}
DUMP_FILE = ROOT + '/.proxy-dump.jsonl'
QUOTA_HINT = ('If you see "429" or "quota", this session\'s free allowance is used up. '
              'Fix: menu Runtime → Restart session. The panel cell is set to run '
              'on startup, so setup starts again by itself.')


def _secret(key):
    try:
        from google.colab import userdata
        return (userdata.get(key) or '').strip()
    except Exception:
        return ''


# Read-only GitHub token from Secrets - only needed if the repo is private.
GH_TOKEN = _secret('OC_PROXY_GITHUB_REPO_TOKEN') or _secret('GITHUB_TOKEN')


def fetch_file(path, dst):
    """Download one repo file via the GitHub API (works for private repos)."""
    req = urllib.request.Request(REPO_API + path,
                                 headers={'Accept': 'application/vnd.github.raw'})
    if GH_TOKEN:
        req.add_header('Authorization', 'Bearer ' + GH_TOKEN)
    with urllib.request.urlopen(req) as r, open(dst, 'wb') as fh:
        fh.write(r.read())


# ---------------------------------------------------------------- UI widgets
out = widgets.Output(layout=widgets.Layout(max_height='300px', overflow_y='auto',
                                           border='1px solid #ccc', padding='6px'))
result_out = widgets.Output()
status = widgets.Label('Status: nothing running yet — begin with Step 1.')
name_label = widgets.Label(
    value='Fixed address name: ' + (_secret('ZROK_NAME') or
          '⚠️ not set — add ZROK_NAME in Secrets (🔑 left sidebar)'))
token_pw = widgets.Password(description='zrok token:', placeholder='paste only if not saved in Secrets',
                            layout=widgets.Layout(width='340px'))
model_dd = widgets.Dropdown(options=MODELS, value='big-pickle', description='Model:')
prompt_text = widgets.Text(value='Say hi in exactly five words.', description='Question:',
                           layout=widgets.Layout(width='420px'))


def say(msg):
    with out:
        print(msg)


def set_status(msg):
    status.value = 'Status: ' + msg


# ------------------------------------------------------------------- helpers
def env():
    e = dict(os.environ)
    e['PATH'] += os.pathsep + os.path.expanduser('~/.bun/bin')
    return e


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def bun(args):
    p = sh(args, cwd=ROOT, env=env(), timeout=600)
    say(p.stdout[-2500:])
    if p.returncode != 0:
        say('(technical details: ' + p.stderr[-500:] + ')')
    return p


def healthy():
    try:
        urllib.request.urlopen(BASE + '/health', timeout=2)
        return True
    except Exception:
        return False


def proxy_env(dump=None):
    e = env()
    if STATE.get('dump') if dump is None else dump:
        e['PROXY_DUMP'] = '1'
        e['PROXY_DUMP_FILE'] = DUMP_FILE
    if STATE.get('opencode'):
        e['PROXY_SYSTEM'] = 'opencode'
    return e


def ensure_proxy():
    if healthy():
        return True
    say('⏳ Starting the proxy…')
    STATE['proxy'] = subprocess.Popen(['bun', 'run', 'proxy.ts'], cwd=ROOT, env=proxy_env(),
                                      stdout=open('/tmp/proxy.log', 'w'),
                                      stderr=subprocess.STDOUT)
    for _ in range(60):
        if healthy():
            say('✅ The proxy is running.')
            return True
        time.sleep(1)
    say('❌ The proxy did not start. What to do: run Step 1 (Setup) once, then try again. '
        'If it keeps failing, restart the session (Runtime → Restart session).')
    return False


# ------------------------------------------------------- request inspector
def restart_proxy(dump):
    """Restart ONLY the proxy (the tunnel keeps pointing at 127.0.0.1:8787,
    so the zrok address stays the same)."""
    p = STATE.get('proxy')
    if p:
        p.terminate()
        STATE['proxy'] = None
    for _ in range(15):
        if not healthy():
            break
        time.sleep(1)
    if healthy():  # started outside the panel (e.g. by Run tests) — stop it too
        sh(['pkill', '-f', 'proxy.ts'])
        for _ in range(15):
            if not healthy():
                break
            time.sleep(1)
    STATE['dump'] = dump
    STATE['proxy'] = subprocess.Popen(['bun', 'run', 'proxy.ts'], cwd=ROOT,
                                      env=proxy_env(dump),
                                      stdout=open('/tmp/proxy.log', 'w'),
                                      stderr=subprocess.STDOUT)
    for _ in range(60):
        if healthy():
            return True
        time.sleep(1)
    return False


def do_dump_on(_=None):
    say('⏳ Turning the request recorder ON and restarting the proxy '
        '(your public address does not change)…')
    if not os.path.exists(ROOT):
        say('❌ What to do: run Step 1 (Setup) first.')
        return
    if restart_proxy(dump=True):
        say('✅ Recording ON → ' + DUMP_FILE)
        say('⚠️ The dump contains FULL prompts and file contents. Reproduce ONE '
            'slow/big request from your app now, then click "Show breakdown" and '
            '"Turn off & clear dump".')
        set_status('recording requests — reproduce one request, then Show breakdown.')
    else:
        say('❌ The proxy did not restart. What to do: run Step 1, then try again.')


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ''.join(p.get('text', '') for p in content if isinstance(p, dict))
    return ''


def do_breakdown(_=None):
    path = DUMP_FILE if os.path.exists(DUMP_FILE) else ROOT + '/src/.proxy-dump.jsonl'
    if not os.path.exists(path):
        say('❌ No dump yet. What to do: click "Enable dump & restart proxy", '
            'send ONE request from your app, then click this again.')
        return
    say('— Request breakdown (approx tokens = chars ÷ 4; the dump itself is at '
        + path + ') —')
    for i, line in enumerate(open(path), 1):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        client, up = rec.get('client', {}), rec.get('upstreamBody', {})
        cmsgs = client.get('messages') or []
        umsgs = up.get('messages') or []
        c_sys = sum(len(_text(m.get('content'))) for m in cmsgs if m.get('role') == 'system')
        u_sys = len(_text(umsgs[0].get('content'))) if umsgs else 0
        other = sum(len(_text(m.get('content'))) for m in umsgs[1:])
        tools = up.get('tools') or []
        sized = sorted(((len(json.dumps(t)), (t.get('function') or {}).get('name')
                         or t.get('name') or '?') for t in tools), reverse=True)
        t_chars = sum(s for s, _ in sized)
        total = u_sys + other + t_chars
        mode = rec.get('sysMode') or 'minimal'
        say(f'Request {i}: model={up.get("model")}  mode={mode}  ≈{total // 4:,} prompt tokens total')
        if mode == 'opencode':
            say(f'  • system text (forwarded as received): {c_sys:>8,} chars  ≈{c_sys // 4:,} tok')
        else:
            say(f'  • our gate stub        : {max(0, u_sys - c_sys):>8,} chars  ≈{max(0, u_sys - c_sys) // 4:,} tok')
            say(f'  • your app system text : {c_sys:>8,} chars  ≈{c_sys // 4:,} tok')
        say(f'  • messages / history   : {other:>8,} chars  ≈{other // 4:,} tok  ({len(umsgs)} msgs)')
        say(f'  • tool definitions     : {t_chars:>8,} chars  ≈{t_chars // 4:,} tok  ({len(tools)} tools)')
        if sized:
            say('    biggest tools: ' + ', '.join(f'{n}≈{s // 4:,}' for s, n in sized[:10]))
    say('How to fix: the biggest slice is the lever. Tools ≫ history ≫ your app '
        'system text ≫ our gate stub (~60 chars, gate-required — the old 13k '
        'OpenCode prepend is gone since 2026-10-25). Trim tools by disabling '
        'unused MCP servers / switching the app to a no-tools Ask mode for '
        'plain questions; trim history by starting a new chat.')


def do_download_dump(_=None):
    if not os.path.exists(DUMP_FILE):
        say('❌ No dump to download yet — enable the dump and send one request first.')
        return
    try:
        from google.colab import files
        files.download(DUMP_FILE)
        say('⬇️ Downloading ' + DUMP_FILE + ' — it contains full prompts; keep it private and delete it after use.')
    except Exception as e:
        say('❌ Download failed (' + str(e) + '). The file is at ' + DUMP_FILE +
            ' in this runtime (left sidebar → Files).')


def do_dump_off(_=None):
    say('⏳ Turning the recorder OFF, deleting the dump, and restarting the proxy…')
    if os.path.exists(DUMP_FILE):
        os.remove(DUMP_FILE)
    if restart_proxy(dump=False):
        say('✅ Recording OFF, dump deleted. Your public address is unchanged.')
        set_status('recording off.')
    else:
        say('❌ The proxy did not restart. What to do: press "3 · Start public address".')


# ------------------------------------------------------------------- actions
def do_setup(_=None):
    try:
        set_status('⏳ Step 1 running…')
        if not os.path.exists(os.path.expanduser('~/.bun/bin/bun')):
            say('⏳ Installing the Bun tool (one-time, about 30 seconds)…')
            subprocess.run('curl -fsSL https://bun.sh/install | bash', shell=True,
                           check=True, capture_output=True, text=True)
        say('✅ Bun ' + sh(['bun', '--version'], env=env()).stdout.strip() + ' is ready.')
        say('⏳ Downloading the project files from GitHub…')
        os.makedirs(ROOT, exist_ok=True)
        for f in FILES:
            dst = os.path.join(ROOT, os.path.basename(f))
            fetch_file(f, dst)
            say('   • ' + os.path.basename(f))
        say('✅ Setup complete. Next: click "2 · Run tests".')
        set_status('Step 1 done — next: Step 2 (Run tests).')
        return True
    except Exception as e:
        say('❌ Setup failed: ' + str(e))
        say('What to do: check the internet connection and click Setup again. If the '
            'GitHub repo is private, the notebook also needs an '
            'OC_PROXY_GITHUB_REPO_TOKEN secret (a read-only GitHub token for this '
            'repo) — see "Help & notes" below.')
        set_status('Step 1 failed — see the Log at the bottom for what to do.')
        return False


def do_tests(_=None):
    try:
        set_status('⏳ Step 2 running (this uses a tiny bit of the free allowance)…')
        say('— Test 1 of 4: listing the free models (this one costs nothing) —')
        if bun(['bun', 'run', 'hit-model.ts', '--list']).returncode != 0:
            raise RuntimeError('the model list could not be loaded')
        say('— Test 2 of 4: asking big-pickle a question —')
        if bun(['bun', 'run', 'hit-model.ts', 'big-pickle',
                'Say hi in exactly five words.']).returncode != 0:
            raise RuntimeError('big-pickle did not answer')
        say('— Test 3 of 4: asking a different model (deepseek) —')
        if bun(['bun', 'run', 'hit-model.ts', 'deepseek-v4.1-flash-free',
                'Say hi in exactly five words.']).returncode != 0:
            raise RuntimeError('deepseek did not answer')
        say('— Test 4 of 4: checking the proxy itself —')
        started_here = False
        proc = None
        if healthy():
            say('✅ The proxy is already running, so we test the live one.')
        else:
            proc = subprocess.Popen(['bun', 'run', 'proxy.ts'], cwd=ROOT, env=proxy_env(),
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True)
            started_here = True
            for _ in range(60):
                if healthy():
                    break
                time.sleep(1)
        models = json.loads(urllib.request.urlopen(BASE + '/v1/models', timeout=10)
                            .read().decode())
        say('✅ The proxy answered with ' + str(len(models.get('data', []))) + ' models.')
        if STATE.get('opencode'):
            health = json.loads(urllib.request.urlopen(BASE + '/health', timeout=10).read().decode())
            if health.get('system') != 'opencode':
                raise RuntimeError('OpenCode mode is selected, but the running proxy is still rewriting requests. Click the OpenCode mode button again.')
            say('✅ OpenCode mode is on: this test stops at the model list. A bare question from the notebook has no system prompt; OpenCode sends that itself.')
        else:
            req = urllib.request.Request(
                BASE + '/v1/chat/completions',
                data=json.dumps({'model': 'big-pickle', 'messages': [
                    {'role': 'user', 'content': 'Say hi in exactly five words.'}]}).encode(),
                headers={'Content-Type': 'application/json'})
            chat = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
            say('✅ The proxy replied: "' + str(chat['choices'][0]['message'].get('content')) + '"')
        if started_here and proc:
            proc.terminate()
        say('✅ All 4 tests passed. Next: Step 3 — start your public address.')
        set_status('Step 2 done, all tests passed — next: Step 3 (Start public address).')
        return True
    except Exception as e:
        say('❌ A test failed: ' + str(e))
        say('What to do: ' + QUOTA_HINT)
        set_status('Step 2 failed — see the Log at the bottom for what to do.')
        return False


def ensure_zrok():
    if sh(['bash', '-c', 'command -v zrok2']).returncode == 0:
        return True
    say('⏳ Installing zrok (one-time)…')
    r = sh(['bash', '-c',
            'curl -fsSL https://github.com/openziti/zrok/releases/download/'
            'v2.0.8/zrok_2.0.8_linux_amd64.tar.gz | tar -xz -C /usr/local/bin zrok2 '
            '&& chmod +x /usr/local/bin/zrok2'])
    if r.returncode != 0:
        say('❌ zrok could not be installed. What to do: press Start again; '
            'if it keeps failing, restart the session (Runtime → Restart session).')
        return False
    return True


def start_zrok():
    if not ensure_zrok():
        return None
    if '<<SET>>' not in sh(['zrok2', 'status']).stdout:
        token = _secret('ZROK_TOKEN') or token_pw.value.strip()
        if not token:
            say('❌ No zrok token found, so we cannot connect to your zrok account.')
            say('What to do: click the 🔑 key icon in Colab\'s left sidebar → Secrets → '
                'add ZROK_TOKEN with your token and turn on "Notebook access", then press '
                'Start again. (Or paste the token in the "zrok token" box above.)')
            return None
        sh(['zrok2', 'enable', '--headless', token])  # the token is never printed
        say('✅ Connected to your zrok account.')
    name = _secret('ZROK_NAME')
    if not name:
        say('❌ No address name found — it must come from your Colab Secrets (no default).')
        say('What to do: click the 🔑 key icon in Colab\'s left sidebar → Secrets → add '
            'ZROK_NAME with the name you want (e.g. my-proxy) and turn on "Notebook '
            'access", then press Start again. Your address will be '
            'https://<that name>.shares.zrok.io.')
        return None
    say('ℹ️ Your fixed address name is "' + name + '" (from the ZROK_NAME secret).')
    sh(['zrok2', 'create', 'name', '-n', 'public', name])
    # Take the name back from any old session that is still holding it.
    listing = sh(['zrok2', 'list', 'shares'])
    for line in (listing.stdout + listing.stderr).splitlines():
        if name in line:
            parts = [c.strip() for c in line.split('│') if c.strip()]
            if len(parts) >= 3:
                sh(['zrok2', 'delete', 'share', parts[0], '--envzid', parts[2]])
                say('♻️ Took the address back from an old session.')
    STATE['tunnel'] = subprocess.Popen(
        ['zrok2', 'share', 'public', '--headless', '--open', '-n', 'public:' + name,
         'localhost:8787'],
        stdout=open('/tmp/zrok.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(60):
        time.sleep(1)
        try:
            txt = open('/tmp/zrok.log').read()
        except Exception:
            continue
        m = re.search(r'[a-z0-9.-]*shares?\.zrok\.io', txt)
        if m:
            return 'https://' + m.group(0)
    say('❌ zrok did not give an address in time. What to do: press Start again.')
    return None


def show_result(url):
    with result_out:
        clear_output()
        display(HTML(
            '<div style="border:2px solid #2e7d32;padding:12px;border-radius:8px;'
            'font-size:15px">✅ <b>Your public address is live:</b><br>'
            '<a href="' + url + '" target="_blank" style="font-size:18px">' + url + '</a>'
            '<br><br><b>Put these settings in your app</b> (Cursor, VS Code, pi.dev):<br>'
            'Address: <code>' + url + '/v1</code><br>'
            'API key: <code>not-needed</code><br><br>'
            '⚠️ Anyone who has this address can use it — there is no password. '
            'Do not post it in public, and press "Stop everything" when you are done.</div>'))


def do_start(_=None):
    try:
        set_status('⏳ Step 3 running…')
        if not ensure_proxy():
            set_status('Step 3 stopped — the proxy would not start. See the Log.')
            return False
        url = start_zrok()
        if not url:
            set_status('Step 3 did not finish — see the Log at the bottom for what to do.')
            return False
        STATE['url'] = url
        show_result(url)
        say('✅ Your public address is live: ' + url)
        set_status('✅ Live! Your address is in the green box in Step 3.')
        return True
    except Exception as e:
        say('❌ Start failed: ' + str(e))
        say('What to do: press Start again. ' + QUOTA_HINT)
        set_status('Step 3 failed — see the Log at the bottom for what to do.')
        return False


def do_all(_=None):
    say('🚀 One-click: doing everything — setup, tests, then start.')
    if not do_setup():
        say('⏹ One-click stopped: Step 1 (Setup) did not finish. Fix that first (see above).')
        return
    if not do_tests():
        say('⏹ One-click stopped: a test failed, so the address was not started. See above.')
        return
    if do_start():
        say('🚀 One-click complete — your public address is in the green box in Step 3.')


def do_stop(_=None):
    for key in ('tunnel', 'proxy'):
        p = STATE.get(key)
        if p:
            p.terminate()
            STATE[key] = None
    STATE['url'] = None
    with result_out:
        clear_output()
    say('⏹ Everything is stopped. The public address no longer works.')
    set_status('stopped. Press "3 · Start public address" whenever you want it back.')


def do_ask(_=None):
    try:
        if not ensure_proxy():
            say('What to do: run Step 1 (Setup) first, then ask again.')
            return
        if STATE.get('opencode'):
            say('❌ The Ask box is off while OpenCode mode is on. That mode forwards the body unchanged, and this box sends only a question — upstream rejects it without OpenCode\'s system prompt. Turn OpenCode mode off to ask from here, or send the question from OpenCode.')
            return
        say('⏳ Asking ' + model_dd.value + '…')
        req = urllib.request.Request(
            BASE + '/v1/chat/completions',
            data=json.dumps({'model': model_dd.value, 'messages': [
                {'role': 'user', 'content': prompt_text.value}]}).encode(),
            headers={'Content-Type': 'application/json'})
        resp = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
        say('🤖 ' + model_dd.value + ' replied: ' +
            str(resp['choices'][0]['message'].get('content')))
    except Exception as e:
        say('❌ That question did not work: ' + str(e))
        say('What to do: ' + QUOTA_HINT)


# --------------------------------------------------------------------- panel
setup_btn = widgets.Button(description='1 · Setup', button_style='primary',
                           layout=widgets.Layout(width='180px'))
test_btn = widgets.Button(description='2 · Run tests', button_style='info',
                          layout=widgets.Layout(width='180px'))
start_btn = widgets.Button(description='3 · Start public address', button_style='success',
                           layout=widgets.Layout(width='240px'))
stop_btn = widgets.Button(description='Stop everything', button_style='danger',
                          layout=widgets.Layout(width='180px'))
ask_btn = widgets.Button(description='Ask', button_style='primary',
                         layout=widgets.Layout(width='120px'))
dump_on_btn = widgets.Button(description='Enable dump & restart proxy', button_style='warning',
                             layout=widgets.Layout(width='240px'))
breakdown_btn = widgets.Button(description='Show breakdown', button_style='info',
                               layout=widgets.Layout(width='180px'))
download_btn = widgets.Button(description='Download dump', layout=widgets.Layout(width='160px'))
dump_off_btn = widgets.Button(description='Turn off & clear dump', button_style='danger',
                              layout=widgets.Layout(width='200px'))
all_btn = widgets.Button(description='🚀 One-click: do everything for me',
                         button_style='success',
                         layout=widgets.Layout(width='100%', height='48px'))
all_btn.on_click(do_all)
setup_btn.on_click(do_setup)
test_btn.on_click(do_tests)
start_btn.on_click(do_start)
stop_btn.on_click(do_stop)
ask_btn.on_click(do_ask)
dump_on_btn.on_click(do_dump_on)
breakdown_btn.on_click(do_breakdown)
download_btn.on_click(do_download_dump)
dump_off_btn.on_click(do_dump_off)

opencode_btn = widgets.ToggleButton(
    value=False,
    description='OpenCode mode: OFF',
    button_style='',
    tooltip='Forward each request body to the API unchanged. Turn on when the client is OpenCode.',
    layout=widgets.Layout(width='220px'),
)


def do_opencode_mode(btn):
    if _RESTORING['on']:
        return
    STATE['opencode'] = bool(btn.value)
    remembered = _remember_opencode_mode(btn.value)
    if btn.value:
        btn.description = 'OpenCode mode: ON'
        btn.button_style = 'success'
        say('✅ OpenCode mode ON. The request body is sent upstream exactly as OpenCode sent it — system text, tools, and sampling fields stay untouched.')
        say('The proxy still adds the identity headers the API requires (User-Agent and session id). The Ask box in this notebook stays off until you turn this mode off.')
    else:
        btn.description = 'OpenCode mode: OFF'
        btn.button_style = ''
        say('✅ OpenCode mode OFF. Cursor, VS Code, and the Ask box get the small gate stub again, and a read-like tool is renamed when the client has none named read.')
    if remembered:
        say('Saved in this browser. After Runtime → Restart session, startup turns OpenCode mode '
            + ('on' if btn.value else 'off') + ' again by itself.')
    else:
        say('⚠️ This browser did not store the choice. After a session restart, OpenCode mode starts off until you turn it on again.')
    if not os.path.exists(ROOT):
        say('It applies when the proxy starts (Step 1, then Step 3).')
        return
    if healthy() or STATE.get('proxy'):
        say('⏳ Restarting the proxy so the mode applies. Your public address stays the same.')
        if restart_proxy(STATE.get('dump', False)):
            say('✅ Proxy restarted in ' + ('OpenCode' if STATE['opencode'] else 'app') + ' mode.')
            set_status(('OpenCode mode on — body forwarded as received.' if STATE['opencode']
                        else 'OpenCode mode off — gate stub on for other apps.') +
                       (' Recording requests.' if STATE.get('dump') else ''))
        else:
            say('❌ The proxy did not restart. What to do: press "3 · Start public address".')
    else:
        say('It applies the next time the proxy starts.')


opencode_btn.on_click(do_opencode_mode)

# The Colab VM disk is wiped on disconnect. The choice lives in this browser
# (localStorage) so the startup cell can turn OpenCode mode back on before
# the proxy launches. A different browser, or cleared site data, starts off.
_MODE_JS_KEY = 'opencode-proxy-mode'
_RESTORING = {'on': False}


def _colab_js(script, timeout=8):
    """Run script in this notebook's page. (value, error, timed_out).

    A missing reply (timeout) is not the same as a stored empty value: the
    script is wrapped so a real answer is always an object.
    """
    try:
        from google.colab import output
    except Exception as e:
        return None, e, False
    wrapped = (
        "(function(){try{return {ok:true, v:(%s)};}"
        "catch(e){return {ok:false, err:String(e)};}})()"
    ) % script
    try:
        try:
            result = output.eval_js(wrapped, timeout_sec=timeout)
        except TypeError:
            result = output.eval_js(wrapped)
    except Exception as e:
        timed_out = isinstance(e, TimeoutError) or 'timeout' in str(e).lower()
        return None, e, timed_out
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except Exception:
            pass
    if not isinstance(result, dict) or 'ok' not in result:
        return None, TimeoutError('the page did not answer'), True
    if result.get('ok'):
        return result.get('v'), None, False
    return None, RuntimeError(str(result.get('err') or 'the page rejected the save')), False


def _remember_opencode_mode(on):
    flag = 'on' if on else 'off'
    value, err, timed_out = _colab_js(
        "localStorage.setItem('" + _MODE_JS_KEY + "', '" + flag + "'); '" + flag + "'")
    return value == flag and not err and not timed_out


def _paint_opencode_button(on):
    _RESTORING['on'] = True
    try:
        opencode_btn.value = on
        opencode_btn.description = 'OpenCode mode: ON' if on else 'OpenCode mode: OFF'
        opencode_btn.button_style = 'success' if on else ''
        STATE['opencode'] = on
    finally:
        _RESTORING['on'] = False


def restore_opencode_mode():
    """Apply the browser's saved OpenCode mode before autorun starts the proxy."""
    saved, err, timed_out = _colab_js("localStorage.getItem('" + _MODE_JS_KEY + "')")
    if timed_out or err:
        say('⚠️ Could not read the saved OpenCode mode from this browser, so this session starts with it off.')
        return
    if saved == 'on':
        _paint_opencode_button(True)
        say('✅ OpenCode mode restored from this browser. Startup will forward request bodies unchanged.')
    elif saved == 'off':
        _paint_opencode_button(False)

zrok_fields = widgets.VBox([name_label, token_pw])


def section(title, children):
    return widgets.VBox(
        [widgets.HTML('<h4 style="margin:4px 0 8px 0">' + title + '</h4>')] + children,
        layout=widgets.Layout(border='1px solid #dadce0', border_radius='8px',
                              padding='10px 12px', margin='8px 0'))


panel = widgets.VBox([
    widgets.HTML('<h3 style="margin:4px 0">🎛️ Control panel</h3>'),
    all_btn,
    widgets.Label('…or work through the steps one by one below:'),
    section('Step 1 · Get ready', [
        setup_btn,
        widgets.Label('One-time: installs the tools and downloads the project (about 30 seconds).')]),
    section('Step 2 · Check it works', [
        test_btn,
        widgets.Label('Runs 4 quick tests. Uses a tiny bit of this session\'s free allowance.')]),
    section('Step 3 · Your public address', [
        widgets.HTML('<b>Your fixed zrok address</b> — the same address every time:'),
        zrok_fields,
        widgets.HBox([start_btn, stop_btn]),
        status,
        result_out,
        opencode_btn,
        widgets.Label('OpenCode mode: turn this ON only when OpenCode itself is the client. '
                      'The body you send is the body posted to the API. Leave it OFF for '
                      'Cursor, VS Code, pi.dev, and the Ask box below. '
                      'This choice is remembered in this browser, so a new session starts in the same mode.')]),
    section('💬 Try the models', [
        widgets.HBox([model_dd, prompt_text, ask_btn]),
        widgets.Label('A quick chat, right here in the notebook. Works once the proxy is running.')]),
    section('🔍 Request inspector — why is a simple question using so many tokens?', [
        widgets.HBox([dump_on_btn, breakdown_btn]),
        widgets.HBox([download_btn, dump_off_btn]),
        widgets.Label('1) Enable the dump  2) Send ONE request from your app  '
                      '3) Show breakdown  4) Turn off & clear. '
                      'Restarting the proxy does not change your public address. '
                      '⚠️ The dump contains full prompts — do not share it.')]),
    section('📜 Log', [out]),
])
display(panel)
say('👋 Session connected. Starting setup, tests, and your public address — no buttons to press.')
restore_opencode_mode()
do_all()
