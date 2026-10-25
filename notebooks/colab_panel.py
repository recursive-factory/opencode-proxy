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
STATE = {'proxy': None, 'tunnel': None, 'url': None}
QUOTA_HINT = ('If you see "429" or "quota", this session\'s free allowance is used up. '
              'Fix: menu Runtime → Restart session, then run the panel cell again.')


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
tunnel_choice = widgets.RadioButtons(
    options=[('zrok — the same address every time (recommended)', 'zrok'),
             ('Cloudflare — a new address each time, no account needed', 'cloudflare')],
    value='zrok', description='', layout=widgets.Layout(width='auto'))
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


def ensure_proxy():
    if healthy():
        return True
    say('⏳ Starting the proxy…')
    STATE['proxy'] = subprocess.Popen(['bun', 'run', 'proxy.ts'], cwd=ROOT, env=env(),
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
    except Exception as e:
        say('❌ Setup failed: ' + str(e))
        say('What to do: check the internet connection and click Setup again. If the '
            'GitHub repo is private, the notebook also needs an '
            'OC_PROXY_GITHUB_REPO_TOKEN secret (a read-only GitHub token for this '
            'repo) — see "Help & notes" below.')
        set_status('Step 1 failed — see the Log at the bottom for what to do.')


def do_tests(_=None):
    try:
        set_status('⏳ Step 2 running (this uses a tiny bit of the free allowance)…')
        say('— Test 1 of 4: listing the free models (this one costs nothing) —')
        bun(['bun', 'run', 'hit-model.ts', '--list'])
        say('— Test 2 of 4: asking big-pickle a question —')
        bun(['bun', 'run', 'hit-model.ts', 'big-pickle', 'Say hi in exactly five words.'])
        say('— Test 3 of 4: asking a different model (deepseek) —')
        bun(['bun', 'run', 'hit-model.ts', 'deepseek-v4.1-flash-free',
             'Say hi in exactly five words.'])
        say('— Test 4 of 4: checking the proxy itself —')
        started_here = False
        proc = None
        if healthy():
            say('✅ The proxy is already running, so we test the live one.')
        else:
            proc = subprocess.Popen(['bun', 'run', 'proxy.ts'], cwd=ROOT, env=env(),
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
    except Exception as e:
        say('❌ A test failed: ' + str(e))
        say('What to do: ' + QUOTA_HINT)
        set_status('Step 2 failed — see the Log at the bottom for what to do.')


def ensure_zrok():
    if sh(['bash', '-c', 'command -v zrok2']).returncode == 0:
        return True
    say('⏳ Installing zrok (one-time)…')
    r = sh(['bash', '-c',
            'curl -fsSL https://github.com/openziti/zrok/releases/download/'
            'v2.0.8/zrok_2.0.8_linux_amd64.tar.gz | tar -xz -C /usr/local/bin zrok2 '
            '&& chmod +x /usr/local/bin/zrok2'])
    if r.returncode != 0:
        say('❌ zrok could not be installed. What to do: try again, or choose '
            'Cloudflare in Step 3 instead (no account needed).')
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
    say('❌ zrok did not give an address in time. What to do: press Start again; '
        'if it keeps failing, choose Cloudflare instead.')
    return None


def start_cloudflare():
    if not os.path.exists('/usr/local/bin/cloudflared'):
        say('⏳ Installing Cloudflare (one-time)…')
        sh(['bash', '-c', 'curl -fsSL https://github.com/cloudflare/cloudflared/releases/'
                          'latest/download/cloudflared-linux-amd64 -o /usr/local/bin/'
                          'cloudflared && chmod +x /usr/local/bin/cloudflared'])
    STATE['tunnel'] = subprocess.Popen(
        ['cloudflared', 'tunnel', '--url', BASE, '--no-autoupdate'],
        stdout=open('/tmp/tunnel.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(90):
        time.sleep(1)
        try:
            txt = open('/tmp/tunnel.log').read()
        except Exception:
            continue
        m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', txt)
        if m:
            return m.group(0)
    say('❌ Cloudflare did not give an address in time. What to do: press Start again.')
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
            return
        url = start_zrok() if tunnel_choice.value == 'zrok' else start_cloudflare()
        if not url:
            set_status('Step 3 did not finish — see the Log at the bottom for what to do.')
            return
        STATE['url'] = url
        show_result(url)
        say('✅ Your public address is live: ' + url)
        set_status('✅ Live! Your address is in the green box in Step 3.')
    except Exception as e:
        say('❌ Start failed: ' + str(e))
        say('What to do: press Start again. ' + QUOTA_HINT)
        set_status('Step 3 failed — see the Log at the bottom for what to do.')


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
setup_btn.on_click(do_setup)
test_btn.on_click(do_tests)
start_btn.on_click(do_start)
stop_btn.on_click(do_stop)
ask_btn.on_click(do_ask)

zrok_fields = widgets.VBox([name_label, token_pw])


def _on_tunnel_change(change):
    # The name/token boxes only matter for zrok - hide them for Cloudflare.
    zrok_fields.layout.display = '' if change['new'] == 'zrok' else 'none'


tunnel_choice.observe(_on_tunnel_change, names='value')


def section(title, children):
    return widgets.VBox(
        [widgets.HTML('<h4 style="margin:4px 0 8px 0">' + title + '</h4>')] + children,
        layout=widgets.Layout(border='1px solid #dadce0', border_radius='8px',
                              padding='10px 12px', margin='8px 0'))


panel = widgets.VBox([
    widgets.HTML('<h3 style="margin:4px 0">🎛️ Control panel — do the steps in order: 1 → 2 → 3</h3>'),
    section('Step 1 · Get ready', [
        setup_btn,
        widgets.Label('One-time: installs the tools and downloads the project (about 30 seconds).')]),
    section('Step 2 · Check it works', [
        test_btn,
        widgets.Label('Runs 4 quick tests. Uses a tiny bit of this session\'s free allowance.')]),
    section('Step 3 · Your public address', [
        widgets.HTML('<b>Choose how people will reach it:</b>'),
        tunnel_choice,
        zrok_fields,
        widgets.HBox([start_btn, stop_btn]),
        status,
        result_out]),
    section('💬 Try the models', [
        widgets.HBox([model_dd, prompt_text, ask_btn]),
        widgets.Label('A quick chat, right here in the notebook. Works once the proxy is running.')]),
    section('📜 Log', [out]),
])
display(panel)
say('👋 Panel ready. Click "1 · Setup" to begin.')
