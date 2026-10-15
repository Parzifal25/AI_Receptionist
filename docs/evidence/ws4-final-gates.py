import os,subprocess,json,pathlib,sys
root=pathlib.Path(__file__).resolve().parents[2]
env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'NODE_ENV':'test','NEXT_PUBLIC_SUPABASE_URL':'http://127.0.0.1:1','NEXT_PUBLIC_SUPABASE_ANON_KEY':'synthetic-anon','SUPABASE_SERVICE_ROLE_KEY':'synthetic-service','NEXT_PUBLIC_APP_URL':'http://localhost:3000','HALO_OUTBOUND_ENABLED':'false','MESSAGING_PROVIDER':'log','EMBEDDING_PROVIDER':'none','HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','PYTHONDONTWRITEBYTECODE':'1'}
commands=[('typecheck',['npm','run','typecheck']),('lint',['npm','run','lint']),('architecture',['npm','run','check:architecture']),('neutral',['npm','run','check:neutral']),('preflight',['npm','run','preflight:ci']),('full-tests',['npm','test','--','--maxWorkers=2']),('worker',[str(root/'.venv/bin/python'),'-m','unittest','discover','-s','services/pipecat-worker','-p','test_*.py']),('build',['npm','run','build']),('diff',['git','diff','--check'])]
results=[]
for name,args in commands:
 # Build can fetch its public Google Font; all other executable gates get
 # their own network namespace with synthetic settings and loopback only.
 cmd=args if name in ['build','diff','typecheck','lint','architecture','neutral'] else ['unshare','-Urn','sh','-c','ip link set lo up && exec "$@"','ws4',*args]
 path=pathlib.Path('/tmp/ws4-final-accepted-'+name+'.log')
 with path.open('w') as log:p=subprocess.run(cmd,cwd=root,env={**env,**({'NODE_ENV':'production'} if name=='build' else {})},stdout=log,stderr=subprocess.STDOUT)
 results.append({'name':name,'invocation':cmd,'exit':p.returncode,'log':str(path)})
 pathlib.Path('/tmp/ws4-final-accepted-results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(name,p.returncode,flush=True)
 if p.returncode:sys.exit(p.returncode)
