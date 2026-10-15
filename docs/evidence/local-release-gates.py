#!/usr/bin/env python3
"""Local gate runner for the release-readiness audit.

Usage: gates.py <label> [gate ...]
Executable suites run in a private network namespace (loopback only) with
synthetic settings, so no test can reach a provider or a shared local port.
Build is excluded unless named explicitly (it fetches Google Fonts).
"""
import json, os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(os.environ.get('HALO_GATE_LOG_DIR', '/tmp/halo-local-release-gates'))
OUT.mkdir(parents=True, exist_ok=True)
ENV = {
    'PATH': os.environ['PATH'], 'HOME': os.environ['HOME'], 'NODE_ENV': 'test',
    'NEXT_PUBLIC_SUPABASE_URL': 'http://127.0.0.1:1', 'NEXT_PUBLIC_SUPABASE_ANON_KEY': 'synthetic-anon',
    'SUPABASE_SERVICE_ROLE_KEY': 'synthetic-service', 'NEXT_PUBLIC_APP_URL': 'http://localhost:3000',
    'HALO_OUTBOUND_ENABLED': 'false', 'MESSAGING_PROVIDER': 'log', 'EMBEDDING_PROVIDER': 'none',
    'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
}
ISOLATE = ['unshare', '-Urn', 'sh', '-c', 'ip link set lo up 2>/dev/null; exec "$@"', 'gate']
GATES = {
    'typecheck': (['npm', 'run', 'typecheck'], False),
    'lint': (['npm', 'run', 'lint'], False),
    'architecture': (['npm', 'run', 'check:architecture'], False),
    'neutral': (['npm', 'run', 'check:neutral'], False),
    'preflight': (['npm', 'run', 'preflight:ci'], True),
    'tests': (['npm', 'test', '--', '--maxWorkers=2'], True),
    'worker': ([str(ROOT / '.venv/bin/python'), '-m', 'unittest', 'discover', '-s', 'services/pipecat-worker', '-p', 'test_*.py'], True),
    'tts-parity': (['npx', 'tsx', 'scripts/check-local-tts-text-parity.ts', '--lines', '2000', '--seed', '20261015'], True),
    'rollout-docs': (['node', 'scripts/check-rollout-docs.mjs'], True),
    'diff-check': (['git', 'diff', '--check'], False),
    'build': (['npm', 'run', 'build'], False),
}

def summarize(name, text):
    if name == 'tests':
        f = re.findall(r'Test Files\s+(.*)', text); t = re.findall(r'Tests\s+(.*)', text)
        return f'files: {f[-1].strip() if f else "?"}; tests: {t[-1].strip() if t else "?"}'
    if name == 'worker':
        r = re.findall(r'Ran (\d+) tests?', text); s = re.findall(r'^(OK.*|FAILED.*)$', text, re.M)
        return f'ran {r[-1] if r else "?"}; {s[-1] if s else "?"}'
    tail = [l for l in text.strip().splitlines() if l.strip()][-1:] if text.strip() else ['(no output)']
    return tail[0][:200]

def main():
    label = sys.argv[1]
    names = sys.argv[2:] or [n for n in GATES if n != 'build']
    results = []
    for name in names:
        args, isolate = GATES[name]
        cmd = (ISOLATE + args) if isolate else args
        log = OUT / f'{label}-{name}.log'
        env = dict(ENV)
        if name == 'build':
            env['NODE_ENV'] = 'production'
        t0 = time.time()
        with log.open('w') as fh:
            p = subprocess.run(cmd, cwd=ROOT, env=env, stdout=fh, stderr=subprocess.STDOUT)
        text = log.read_text(errors='replace')
        r = {'gate': name, 'command': ' '.join(args), 'isolated': isolate, 'exit': p.returncode,
             'seconds': round(time.time() - t0, 1), 'summary': summarize(name, text), 'log': str(log)}
        results.append(r)
        print(json.dumps(r), flush=True)
    (OUT / f'{label}-results.json').write_text(json.dumps(results, indent=2) + '\n')

if __name__ == '__main__':
    main()
