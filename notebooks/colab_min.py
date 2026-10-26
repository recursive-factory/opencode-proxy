"""Minimal Colab runtime: proxy + zrok, then a loop that never returns.

Each proxy log line is printed in this cell. A free-limit line
(upstream 429 / FreeUsageLimitError) posts oc-limit-hit to Tampermonkey
and immediately calls runtime.unassign(). Leave the cell on [*].
"""
import json
import os
import re
import subprocess
import time
import urllib.request

ROOT = '/content/opencode-proxy'
BASE = 'http://127.0.0.1:8787'
LOG = '/tmp/proxy.log'
REPO_API = 'https://api.github.com/repos/recursive-factory/opencode-proxy/contents/'
FILES = ['src/fingerprint.ts', 'src/hit-model.ts', 'src/proxy.ts',
         'src/minimize-system.ts', 'data/opencode-system.txt', 'package.json']


def secret(key):
    try:
        from google.colab import userdata
        return (userdata.get(key) or '').strip()
    except Exception:
        return ''


GH_TOKEN = secret('OC_PROXY_GITHUB_REPO_TOKEN') or secret('GITHUB_TOKEN')


def log(msg):
    print(msg, flush=True)


def env():
    e = dict(os.environ)
    e['PATH'] += os.pathsep + os.path.expanduser('~/.bun/bin')
    e['PROXY_SYSTEM'] = 'opencode'
    return e


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, env=env(), **kw)


def fetch_file(path, dst):
    req = urllib.request.Request(REPO_API + path, headers={'Accept': 'application/vnd.github.raw'})
    if GH_TOKEN:
        req.add_header('Authorization', 'Bearer ' + GH_TOKEN)
    with urllib.request.urlopen(req) as r, open(dst, 'wb') as fh:
        fh.write(r.read())


def post(payload):
    """Hand a message to the Colab page. Must run on this cell's thread."""
    from google.colab import output
    script = ("(()=>{try{window.top.postMessage(" + json.dumps(payload) +
              ",'https://colab.research.google.com');}catch(e){} return 'posted';})()")
    try:
        output.eval_js(script)
    except TypeError:
        output.eval_js(script)


def pause(seconds=1):
    from google.colab import output
    ms = int(seconds * 1000)
    try:
        output.eval_js("new Promise(function(r){setTimeout(function(){r('tick');}," + str(ms) + ")})")
    except Exception:
        time.sleep(seconds)


def healthy():
    try:
        urllib.request.urlopen(BASE + '/health', timeout=2)
        return True
    except Exception:
        return False


def setup():
    if not os.path.exists(os.path.expanduser('~/.bun/bin/bun')):
        log('installing bun')
        subprocess.run('curl -fsSL https://bun.sh/install | bash', shell=True, check=True)
    log('bun ' + sh(['bun', '--version']).stdout.strip())
    os.makedirs(ROOT, exist_ok=True)
    # Flat copy, same as the panel: proxy.ts imports ./fingerprint.ts and
    # looks for opencode-system.txt beside itself.
    for path in FILES:
        name = os.path.basename(path)
        fetch_file(path, os.path.join(ROOT, name))
        log('got ' + name)


def start_proxy():
    if healthy():
        log('proxy already up')
        return
    log('starting proxy')
    subprocess.Popen(['bun', 'run', 'proxy.ts'], cwd=ROOT, env=env(),
                     stdout=open(LOG, 'w'), stderr=subprocess.STDOUT)
    for _ in range(60):
        if healthy():
            log('proxy listening on 8787')
            return
        time.sleep(1)
    try:
        tail = open(LOG, errors='replace').read()[-2000:]
    except Exception:
        tail = ''
    raise RuntimeError('proxy did not start\n' + tail)


def start_zrok():
    if sh(['bash', '-c', 'command -v zrok2']).returncode != 0:
        log('installing zrok')
        r = sh(['bash', '-c',
                'curl -fsSL https://github.com/openziti/zrok/releases/download/'
                'v2.0.8/zrok_2.0.8_linux_amd64.tar.gz | tar -xz -C /usr/local/bin zrok2 '
                '&& chmod +x /usr/local/bin/zrok2'])
        if r.returncode != 0:
            raise RuntimeError('zrok install failed')
    if '<<SET>>' not in sh(['zrok2', 'status']).stdout:
        token = secret('ZROK_TOKEN')
        if not token:
            raise RuntimeError('set ZROK_TOKEN in Colab Secrets')
        sh(['zrok2', 'enable', '--headless', token])
        log('zrok enabled')
    name = secret('ZROK_NAME')
    if not name:
        raise RuntimeError('set ZROK_NAME in Colab Secrets')
    sh(['zrok2', 'create', 'name', '-n', 'public', name])
    listing = sh(['zrok2', 'list', 'shares'])
    for line in (listing.stdout + listing.stderr).splitlines():
        if name in line:
            parts = [c.strip() for c in line.split('│') if c.strip()]
            if len(parts) >= 3:
                sh(['zrok2', 'delete', 'share', parts[0], '--envzid', parts[2]])
                log('released old share ' + name)
    subprocess.Popen(
        ['zrok2', 'share', 'public', '--headless', '--open', '-n', 'public:' + name, 'localhost:8787'],
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
    raise RuntimeError('zrok did not publish an address')


def is_limit(line):
    return 'upstream 429' in line or 'freeusagelimit' in line.lower()


def signal_and_stop(line):
    log('LIMIT ' + line.strip())
    log('posting oc-limit-hit, then unassign')
    post({'type': 'oc-limit-hit', 'ts': int(time.time() * 1000), 'source': 'proxy log'})
    from google.colab import runtime
    runtime.unassign()


def follow():
    try:
        offset = os.path.getsize(LOG)
    except Exception:
        offset = 0
    post({'type': 'oc-panel-started', 'ts': int(time.time() * 1000)})
    log('watching ' + LOG + ' — leave this cell running')
    while True:
        try:
            if os.path.exists(LOG):
                if os.path.getsize(LOG) < offset:
                    offset = 0
                with open(LOG, errors='replace') as fh:
                    fh.seek(offset)
                    lines = fh.readlines()
                    offset = fh.tell()
                for line in lines:
                    text = line.rstrip()
                    if not text:
                        continue
                    log(text)
                    if is_limit(text):
                        signal_and_stop(text)
                        return
        except Exception as e:
            log('watch error: ' + str(e))
        pause(1)


setup()
start_proxy()
url = start_zrok()
log('public ' + url)
follow()
