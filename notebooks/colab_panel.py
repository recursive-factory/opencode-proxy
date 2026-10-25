"""Non-coder control panel for the OpenCode Free-Model Proxy (Colab).

The notebook cell just downloads and execs this file. Everything is driven
by buttons: Setup -> Run tests -> Start public URL -> Stop. No coding needed.
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
RAW = 'https://raw.githubusercontent.com/recursive-factory/opencode-proxy/main/'
FILES = ['src/fingerprint.ts', 'src/hit-model.ts', 'src/proxy.ts',
         'src/minimize-system.ts', 'data/opencode-system.txt', 'package.json']
MODELS = ['big-pickle', 'beam-free', 'deepseek-v4.1-flash-free', 'flint-40b-free',
          'glm-5.3-flash-free', 'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free',
          'nemotron-3.5-super-vl-free']
STATE = {'proxy': None, 'tunnel': None, 'url': None}


def _secret(key):
    try:
        from google.colab import userdata
        return (userdata.get(key) or '').strip()
    except Exception:
        return ''


# ---------------------------------------------------------------- UI widgets
out = widgets.Output(layout=widgets.Layout(max_height='300px', overflow_y='auto',
                                           border='1px solid #ccc', padding='6px'))
result_out = widgets.Output()
status = widgets.Label('Status: not started yet')
name_label = widgets.Label(
    value='Share name: ' + (_secret('ZROK_NAME') or 'oc-llm-proxy') +
          '  (from Colab Secrets: ZROK_NAME - read again when you press Start)')
token_pw = widgets.Password(description='zrok token:', placeholder='only if not saved in Secrets',
                            layout=widgets.Layout(width='320px'))
tunnel_choice = widgets.RadioButtons(
    options=[('zrok - fixed URL (recommended)', 'zrok'), ('Cloudflare - random URL', 'cloudflare')],
    value='zrok', description='Tunnel:')
model_dd = widgets.Dropdown(options=MODELS, value='big-pickle', description='Model:')
prompt_text = widgets.Text(value='Say hi in exactly five words.', description='Ask:',
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
        say('STDERR: ' + p.stderr[-800:])
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
    say('Starting the proxy...')
    STATE['proxy'] = subprocess.Popen(['bun', 'run', 'proxy.ts'], cwd=ROOT, env=env(),
                                      stdout=open('/tmp/proxy.log', 'w'),
                                      stderr=subprocess.STDOUT)
    for _ in range(60):
        if healthy():
            say('Proxy is running.')
            return True
        time.sleep(1)
    say('Proxy did not start - see /tmp/proxy.log')
    return False


# ------------------------------------------------------------------- actions
def do_setup(_=None):
    try:
        set_status('setting up...')
        if not os.path.exists(os.path.expanduser('~/.bun/bin/bun')):
            say('Installing Bun (one-time, ~30s)...')
            subprocess.run('curl -fsSL https://bun.sh/install | bash', shell=True,
                           check=True, capture_output=True, text=True)
        say('Bun ' + sh(['bun', '--version'], env=env()).stdout.strip() + ' ready.')
        say('Downloading project files from GitHub...')
        os.makedirs(ROOT, exist_ok=True)
        for f in FILES:
            dst = os.path.join(ROOT, os.path.basename(f))
            urllib.request.urlretrieve(RAW + f, dst)
            say('  ' + os.path.basename(f) + '  ' + str(os.path.getsize(dst)) + ' bytes')
        say('Setup complete.')
        set_status('setup done - next: Run tests (step 2)')
    except Exception as e:
        say('Setup failed: ' + str(e))
        set_status('setup failed - see log above')


def do_tests(_=None):
    try:
        set_status('running tests (uses a little free quota)...')
        say('== 1/4  Free models (no quota spent) ==')
        bun(['bun', 'run', 'hit-model.ts', '--list'])
        say('== 2/4  Hit big-pickle ==')
        bun(['bun', 'run', 'hit-model.ts', 'big-pickle', 'Say hi in exactly five words.'])
        say('== 3/4  Hit deepseek (different model = different identity block) ==')
        bun(['bun', 'run', 'hit-model.ts', 'deepseek-v4.1-flash-free',
             'Say hi in exactly five words.'])
        say('== 4/4  Proxy smoke test ==')
        started_here = False
        if healthy():
            say('health: OK (proxy already running - testing the live one)')
        else:
            proc = subprocess.Popen(['bun', 'run', 'proxy.ts'], cwd=ROOT, env=env(),
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True)
            started_here = True
            for _ in range(60):
                if healthy():
                    say('health: OK')
                    break
                time.sleep(1)
        say('models: ' + urllib.request.urlopen(BASE + '/v1/models', timeout=10)
            .read().decode()[:300])
        req = urllib.request.Request(
            BASE + '/v1/chat/completions',
            data=json.dumps({'model': 'big-pickle', 'messages': [
                {'role': 'user', 'content': 'Say hi in exactly five words.'}]}).encode(),
            headers={'Content-Type': 'application/json'})
        say('chat: ' + urllib.request.urlopen(req, timeout=180).read().decode()[:600])
        if started_here:
            proc.terminate()
        say('All tests done.')
        set_status('tests done - next: Start public URL (step 3)')
    except Exception as e:
        say('Tests failed: ' + str(e))
        set_status('tests failed - see log above')


def ensure_zrok():
    if sh(['bash', '-c', 'command -v zrok2']).returncode == 0:
        return True
    say('Installing zrok (one-time)...')
    r = sh(['bash', '-c',
            'curl -fsSL https://github.com/openziti/zrok/releases/download/'
            'v2.0.8/zrok_2.0.8_linux_amd64.tar.gz | tar -xz -C /usr/local/bin zrok2 '
            '&& chmod +x /usr/local/bin/zrok2'])
    if r.returncode != 0:
        say('zrok install failed: ' + r.stderr[-500:])
        return False
    return True


def start_zrok():
    if not ensure_zrok():
        return None
    if '<<SET>>' not in sh(['zrok2', 'status']).stdout:
        token = _secret('ZROK_TOKEN') or token_pw.value.strip()
        if not token:
            say('No zrok token found. Add ZROK_TOKEN in the Secrets panel '
                '(key icon, left side) or paste it in the "zrok token" box above.')
            return None
        sh(['zrok2', 'enable', '--headless', token])  # token never printed
        say('zrok enabled.')
    name = _secret('ZROK_NAME') or 'oc-llm-proxy'
    say('Share name: ' + name + ' (from Colab secret ZROK_NAME)')
    sh(['zrok2', 'create', 'name', '-n', 'public', name])
    # Reclaim the name from any old session's share still holding it.
    listing = sh(['zrok2', 'list', 'shares'])
    for line in (listing.stdout + listing.stderr).splitlines():
        if name in line:
            parts = [c.strip() for c in line.split('│') if c.strip()]
            if len(parts) >= 3:
                sh(['zrok2', 'delete', 'share', parts[0], '--envzid', parts[2]])
                say('Reclaimed the name from an old session.')
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
    say('zrok did not report a URL - see /tmp/zrok.log')
    return None


def start_cloudflare():
    if not os.path.exists('/usr/local/bin/cloudflared'):
        say('Installing cloudflared (one-time)...')
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
    say('Cloudflare did not report a URL - see /tmp/tunnel.log')
    return None


def show_result(url):
    with result_out:
        clear_output()
        display(HTML(
            '<div style="border:2px solid #2e7d32;padding:12px;border-radius:8px;'
            'font-size:15px">✅ <b>Your public URL is live:</b><br>'
            '<a href="' + url + '" target="_blank" style="font-size:18px">' + url + '</a>'
            '<br><br><b>Client settings</b> (Cursor / VS Code / pi):<br>'
            'Base URL: <code>' + url + '/v1</code><br>'
            'API key: <code>not-needed</code> (anyone with the URL can use it - '
            'do not share it publicly)</div>'))


def do_start(_=None):
    try:
        set_status('starting public URL...')
        if not ensure_proxy():
            set_status('proxy failed to start - see log above')
            return
        url = start_zrok() if tunnel_choice.value == 'zrok' else start_cloudflare()
        if not url:
            set_status('could not start the tunnel - see log above')
            return
        STATE['url'] = url
        show_result(url)
        say('Public URL is live: ' + url)
        set_status('public URL is live - copy it from the green box')
    except Exception as e:
        say('Start failed: ' + str(e))
        set_status('start failed - see log above')


def do_stop(_=None):
    for key in ('tunnel', 'proxy'):
        p = STATE.get(key)
        if p:
            p.terminate()
            STATE[key] = None
    STATE['url'] = None
    with result_out:
        clear_output()
    say('Everything stopped. The public URL no longer works.')
    set_status('stopped')


def do_ask(_=None):
    try:
        if not ensure_proxy():
            say('Proxy is not running and could not be started.')
            return
        say('Asking ' + model_dd.value + ' ...')
        req = urllib.request.Request(
            BASE + '/v1/chat/completions',
            data=json.dumps({'model': model_dd.value, 'messages': [
                {'role': 'user', 'content': prompt_text.value}]}).encode(),
            headers={'Content-Type': 'application/json'})
        resp = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
        say('Reply: ' + str(resp['choices'][0]['message'].get('content')))
    except Exception as e:
        say('Ask failed: ' + str(e))


# --------------------------------------------------------------------- panel
setup_btn = widgets.Button(description='1. Setup', button_style='primary',
                           layout=widgets.Layout(width='180px'))
test_btn = widgets.Button(description='2. Run tests', button_style='info',
                          layout=widgets.Layout(width='180px'))
start_btn = widgets.Button(description='3. Start public URL', button_style='success',
                           layout=widgets.Layout(width='220px'))
stop_btn = widgets.Button(description='Stop everything', button_style='danger',
                          layout=widgets.Layout(width='180px'))
ask_btn = widgets.Button(description='Ask the model', button_style='primary',
                         layout=widgets.Layout(width='180px'))
setup_btn.on_click(do_setup)
test_btn.on_click(do_tests)
start_btn.on_click(do_start)
stop_btn.on_click(do_stop)
ask_btn.on_click(do_ask)

display(HTML('<h3>Control panel - click the buttons in order: 1 → 2 → 3</h3>'))
display(widgets.HBox([setup_btn, test_btn]))
display(widgets.HBox([tunnel_choice, widgets.VBox([name_label, token_pw])]))
display(widgets.HBox([start_btn, stop_btn]))
display(status)
display(result_out)
display(HTML('<b>Try it right here:</b> pick a model, type a question, click Ask.'))
display(widgets.HBox([model_dd, prompt_text, ask_btn]))
display(HTML('<b>Log:</b>'))
display(out)
say('Panel ready. Start with "1. Setup".')
