import os,sys,subprocess,json
from pathlib import Path
root=Path(__file__).resolve().parents[2]
env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'NODE_ENV':'test','NEXT_PUBLIC_SUPABASE_URL':'http://127.0.0.1:1','NEXT_PUBLIC_SUPABASE_ANON_KEY':'synthetic-anon','SUPABASE_SERVICE_ROLE_KEY':'synthetic-service','NEXT_PUBLIC_APP_URL':'http://localhost:3000','HALO_OUTBOUND_ENABLED':'false','MESSAGING_PROVIDER':'log','EMBEDDING_PROVIDER':'none','HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','PYTHONDONTWRITEBYTECODE':'1'}
commands={
 'full-tests':['npm','test','--','--maxWorkers=2'],
 'worker':[str(root/'.venv/bin/python'),'-m','unittest','discover','-s','services/pipecat-worker','-p','test_*.py'],
 'boundary':['npm','test','--','tests/integration/ws4-audit-correlation.test.ts','tests/integration/pipecat-gateway.test.ts','tests/integration/web-stt-gateway.test.ts','tests/integration/web-tts-gateway.test.ts','--maxWorkers=2'],
}
key=sys.argv[1]
cmd=['unshare','-Urn','sh','-c','ip link set lo up && exec "$@"','ws4',*commands[key]]
with open('/tmp/ws4-final-isolated-'+key+'.log','w') as log:
 result=subprocess.run(cmd,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
Path('/tmp/ws4-final-isolated-'+key+'.json').write_text(json.dumps({'command':cmd,'exit':result.returncode}))
print(key,'exit',result.returncode)
sys.exit(result.returncode)
