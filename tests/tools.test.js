import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';

async function server(t, handler) {
  const s=createServer(handler); await new Promise(r=>s.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
  return `http://127.0.0.1:${s.address().port}`;
}

function fakeRuntime() {
  return {stats:{recalls:0,recallFailed:0,accepted:0,completed:0,failed:0,dropped:0},pending:new Map()};
}

function baseConfig(overrides={}) {
  return {enabled:true,autoRecall:true,autoRetain:true,apiUrl:'http://127.0.0.1:1',apiKey:'',
    apiKeyEnv:'HINDSIGHT_API_KEY',bankId:'personal',recallBudget:'mid',
    recallTypes:['observation'],recallMaxTokens:1024,maxMemories:8,allowHttp:false,...overrides};
}

test('HTTP client allows plain HTTP to a non-loopback host only when allowHttp is explicitly on',async t=>{
  const {HindsightClient}=await import('../lib/http.js');
  let requests=0;
  const base=await server(t,(req,res)=>{requests++;res.end('{}');});
  // 外部主机名的 http 默认仍拒绝
  assert.throws(()=>new HindsightClient({apiUrl:'http://mem.example.internal:8888',bankId:'bank'}),
    error=>error.code==='CONFIG');
  // allowHttp 开启后真实请求放行（对外部主机名的请求会因 DNS 失败归为 NETWORK）
  await assert.rejects(
    ()=>new HindsightClient({apiUrl:'http://mem.example.internal:8888',bankId:'bank',allowHttp:true,timeoutMs:500}).recall({query:'x'}),
    error=>error.code==='NETWORK'||error.code==='TIMEOUT');
  // allowHttp 开启后真实请求放行
  const client=new HindsightClient({apiUrl:base,bankId:'bank',allowHttp:true,timeoutMs:500});
  const response=await client.recall({query:'x'});
  assert.equal(typeof response,'object');
  assert.equal(requests,1);
});

test('tool definitions expose hindsight_recall / hindsight_reflect / hindsight_status with string-only schemas',async t=>{
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const defs=buildToolDefinitions({snapshot:()=>baseConfig(),clientFor:()=>{throw new Error('unused');},statsOf:fakeRuntime});
  const names=defs.map(d=>d.name);
  for (const name of ['hindsight_recall','hindsight_reflect','hindsight_status']) assert.ok(names.includes(name),name);
  for (const def of defs) {
    assert.equal(typeof def.description,'string');
    assert.ok(def.description.length>10);
    assert.equal(def.output?.schema?.type,'string');
    for (const key of Object.keys(def.parameters?.properties ?? {})) {
      assert.equal(def.parameters.properties[key].type,'string',`${def.name}.${key} must be string`);
    }
  }
  assert.deepEqual(defs.find(d=>d.name==='hindsight_recall').parameters.required,['query']);
  assert.deepEqual(defs.find(d=>d.name==='hindsight_reflect').parameters.required,['query']);
});

test('hindsight_recall queries the configured bank with the turn budget and formats results as list text',async t=>{
  let seen;
  const base=await server(t,(req,res)=>{
    seen={url:req.url,auth:req.headers.authorization};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({results:[{text:'用户的深色模式偏好保持不变。'},{text:'部署端口是 8080'}]}));
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:500}),statsOf:()=>stats});
  const recall=defs.find(d=>d.name==='hindsight_recall');
  const text=await recall.execute({query:'深色模式'});
  assert.match(text,/用户的深色模式偏好保持不变/);
  assert.match(text,/部署端口是 8080/);
  assert.ok(!/Relevant memory/.test(text),'tool output must not reuse the injection preamble');
  assert.deepEqual(seen,{url:'/v1/default/banks/personal/memories/recall',auth:undefined});
  assert.equal(stats.stats.recalls,1);
});

test('hindsight_recall reports an empty bank instead of injecting a blank block and does not count as failure',async t=>{
  const base=await server(t,(req,res)=>{
    res.setHeader('content-type','application/json');res.end(JSON.stringify({results:[]}));
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:500}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_recall').execute({query:'不存在的主题'});
  assert.ok(/没有/.test(text));
  assert.equal(stats.stats.recalls,1);
  assert.equal(stats.stats.recallFailed,0);
});

test('hindsight_recall stays silent on server failure and surfaces the failure to the model as tool text',async t=>{
  const base=await server(t,(req,res)=>{res.writeHead(500);res.end('{}');});
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_recall').execute({query:'x'});
  assert.match(text,/失败|不可用|Hindsight/);
  assert.equal(stats.stats.recallFailed,1);
});

test('hindsight_recall and hindsight_reflect honor disabled config by refusing to call the server',async t=>{
  let requests=0;
  const base=await server(t,(req,res)=>{requests++;res.end('{}');});
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const config=baseConfig({apiUrl:base,enabled:false});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:fakeRuntime});
  for (const name of ['hindsight_recall','hindsight_reflect']) {
    const text=await defs.find(d=>d.name===name).execute({query:'x'});
    assert.match(text,/停用|禁用|disabled/i,name);
  }
  assert.equal(requests,0,'disabled config must produce zero server requests');
});

test('hindsight_reflect posts to the bank reflect endpoint and returns the synthesis text',async t=>{
  let seen;
  const base=await server(t,(req,res)=>{
    seen=req.url;
    res.setHeader('content-type','application/json');
    res.end(Buffer.from(JSON.stringify({text:'综合结论：用户偏好自托管服务。'}),'utf8'));
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const config=baseConfig({apiUrl:base});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:500}),statsOf:fakeRuntime});
  const text=await defs.find(d=>d.name==='hindsight_reflect').execute({query:'用户的部署习惯'});
  assert.match(text,/综合结论/);
  assert.equal(seen,'/v1/default/banks/personal/reflect');
});

test('hindsight_recall redacts recalled text with the same policy as the auto-recall block',async t=>{
  const base=await server(t,(req,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({results:[{text:'服务器密码 password=supersecret123 不要外传'}]}));
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const config=baseConfig({apiUrl:base});
  const stats=fakeRuntime();
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:500}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_recall').execute({query:'服务器密码'});
  assert.ok(!text.includes('supersecret123'),'tool output must apply redactSecrets');
  assert.match(text,/REDACTED/);
});

test('hindsight_status reports config shape and runtime counters without leaking the API key',async t=>{
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const stats=fakeRuntime();
  stats.stats.accepted=3;stats.pending.set('doc-1',{});
  const config=baseConfig({apiKey:'synthetic-secret-value'});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:()=>{throw new Error('unused');},statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_status').execute({});
  assert.match(text,/personal/);
  assert.match(text,/已接受 3/);
  assert.match(text,/进行中 1/);
  assert.ok(!text.includes('synthetic-secret-value'),'status must never carry the API key');
});

test('hindsight_retain definition exists with content required and string-only params',async t=>{
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const defs=buildToolDefinitions({snapshot:()=>baseConfig(),clientFor:()=>{throw new Error('unused');},statsOf:fakeRuntime});
  const def=defs.find(d=>d.name==='hindsight_retain');
  assert.ok(def,'hindsight_retain must be registered');
  assert.deepEqual(def.parameters.required,['content']);
  for (const key of Object.keys(def.parameters.properties)) {
    assert.equal(def.parameters.properties[key].type,'string',`${key} must be string (tags use comma form)`);
  }
});

test('hindsight_retain submits async with merged tags, context and occurred_at, returns queued text at once',async t=>{
  let posts=[];
  const base=await server(t,(req,res)=>{
    let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
      const entry={method:req.method,url:req.url,body:JSON.parse(raw||'{}')};
      if (req.method==='POST') posts.push(entry);
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(req.method==='POST' ? {success:true,async:true,operation_id:'op-1'} : {status:'completed'}));
    });
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base,retainTags:['source:dsh'],retainTimeoutMs:500,operationTimeoutMs:120,operationPollMs:20});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:500}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_retain').execute({
    content:'用户偏好自托管服务',
    context:'user preference',
    tags:'测试来源, 另一标签',
    occurred_at:'2026-11-24T10:00:00+08:00',
  });
  assert.match(text,/已排队|queued/i,'tool must return immediately, not wait for extraction');
  assert.equal(posts.length,1,'exactly one POST (the retain submit)');
  const seen=posts[0];
  assert.equal(seen.url,'/v1/default/banks/personal/memories');
  const item=seen.body.items[0];
  assert.equal(item.content,'用户偏好自托管服务');
  assert.equal(item.context,'user preference');
  assert.deepEqual(item.tags,['source:dsh','测试来源','另一标签'],'call tags merge with configured default tags');
  assert.equal(item.timestamp,'2026-11-24T10:00:00+08:00');
  assert.equal(seen.body.async,true,'tool retain must be async like Hermes');
});

test('hindsight_retain counts into accepted and the background poll raises completed',async t=>{
  const base=await server(t,(req,res)=>{
    if (req.method==='POST') {
      let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({success:true,async:true,operation_id:'op-9'}));
      });
    } else {
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({status:'completed'}));
    }
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base,retainTimeoutMs:500,operationTimeoutMs:400,operationPollMs:15});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:500}),statsOf:()=>stats});
  await defs.find(d=>d.name==='hindsight_retain').execute({content:'一条事实'});
  await new Promise(r=>setTimeout(r,120));
  assert.equal(stats.stats.accepted,1);
  assert.equal(stats.stats.completed,1,'background poll must mark the async op completed');
  assert.equal(stats.stats.failed,0);
});

test('hindsight_retain refuses empty content and disabled config with zero server requests',async t=>{
  let requests=0;
  const base=await server(t,(req,res)=>{requests++;res.end('{}');});
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const defs=buildToolDefinitions({snapshot:()=>baseConfig({apiUrl:base}),clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  const t1=await defs.find(d=>d.name==='hindsight_retain').execute({content:'   '});
  assert.match(t1,/content/);
  const defs2=buildToolDefinitions({snapshot:()=>baseConfig({apiUrl:base,enabled:false}),clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  const t2=await defs2.find(d=>d.name==='hindsight_retain').execute({content:'x'});
  assert.match(t2,/停用/);
  assert.equal(requests,0);
});

test('hindsight_retain surfaces server failure as text and counts failed, never throws',async t=>{
  const base=await server(t,(req,res)=>{res.writeHead(500);res.end('{}');});
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base,retainTimeoutMs:300});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_retain').execute({content:'x'});
  assert.match(text,/失败|不可用/);
  assert.equal(stats.stats.failed,1);
});

test('hindsight_retain redacts secrets in content before submitting',async t=>{
  let posts=[];
  const base=await server(t,(req,res)=>{
    let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
      if (req.method==='POST') posts.push(JSON.parse(raw||'{}'));
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(req.method==='POST' ? {success:true,async:true,operation_id:'op-3'} : {status:'completed'}));
    });
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base,retainTimeoutMs:500,operationTimeoutMs:120,operationPollMs:15});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:500}),statsOf:()=>stats});
  await defs.find(d=>d.name==='hindsight_retain').execute({content:'服务器密码 password=supersecret123 记下来'});
  assert.ok(posts.length===1 && !posts[0].items[0].content.includes('supersecret123'),'content must pass redactSecrets');
});

test('hindsight_retain rejects an unparseable occurred_at with a usage hint',async t=>{
  let requests=0;
  const base=await server(t,(req,res)=>{requests++;res.end('{}');});
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const defs=buildToolDefinitions({snapshot:()=>baseConfig({apiUrl:base}),clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_retain').execute({content:'x',occurred_at:'下礼拜二'});
  assert.match(text,/occurred_at/);
  assert.equal(requests,0);
});

test('hindsight_retain reports INVALID_RESPONSE as failed text when no operation id comes back',async t=>{
  let posts=0;
  const base=await server(t,(req,res)=>{
    if (req.method==='POST') { posts++; res.end(JSON.stringify({success:true,async:true})); }
    else res.end(JSON.stringify({status:'completed'}));
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base,retainTimeoutMs:300});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_retain').execute({content:'x'});
  assert.match(text,/INVALID_RESPONSE|写入失败/);
  assert.equal(stats.stats.failed,1);
  assert.equal(stats.stats.accepted,0,'no accepted count on invalid response');
});

test('hindsight_retain counts operation-level failure via the background poll',async t=>{
  const base=await server(t,(req,res)=>{
    if (req.method==='POST') res.end(JSON.stringify({success:true,async:true,operation_id:'op-f'}));
    else res.end(JSON.stringify({status:'failed'}));
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base,retainTimeoutMs:300,operationTimeoutMs:400,operationPollMs:15});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_retain').execute({content:'x'});
  assert.match(text,/已排队/,'submit succeeded, so the tool reply stays queued');
  await new Promise(r=>setTimeout(r,150));
  assert.equal(stats.stats.accepted,1);
  assert.equal(stats.stats.completed,0);
  assert.equal(stats.stats.failed,1,'operation-level failure must raise failed via the poll');
  assert.equal(stats.pending.size,0,'poll cleanup must clear the pending entry');
});

test('hindsight_retain truncates content to maxRetainChars before submitting',async t=>{
  let bodies=[];
  const base=await server(t,(req,res)=>{
    if (req.method==='POST') { let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{ bodies.push(JSON.parse(raw||'{}')); res.end(JSON.stringify({success:true,async:true,operation_id:'op-t'})); }); }
    else res.end(JSON.stringify({status:'completed'}));
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base,maxRetainChars:16,retainTimeoutMs:300,operationTimeoutMs:120,operationPollMs:15});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  await defs.find(d=>d.name==='hindsight_retain').execute({content:'这个内容远远超过了十六个字符的上限所以必须被截断'});
  assert.equal(bodies.length,1);
  assert.ok(bodies[0].items[0].content.length<=16,'content must be capped at maxRetainChars');
});

test('hindsight_retain refuses to submit when the write queue is full and counts dropped',async t=>{
  let requests=0;
  const base=await server(t,(req,res)=>{requests++;res.end('{}');});
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  stats.pending.set('pending-1',{session:null,promise:Promise.resolve()});
  const config=baseConfig({apiUrl:base,maxPendingWrites:1,retainTimeoutMs:300});
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats});
  const text=await defs.find(d=>d.name==='hindsight_retain').execute({content:'x'});
  assert.match(text,/队列已满/);
  assert.equal(requests,0,'queue-full must produce zero network requests');
  assert.equal(stats.stats.dropped,1);
});

test('hindsight_retain aborts the background poll with the lifecycle signal and clears pending',async t=>{
  const base=await server(t,(req,res)=>{
    if (req.method==='POST') res.end(JSON.stringify({success:true,async:true,operation_id:'op-a'}));
    else res.end(JSON.stringify({status:'running'}));
  });
  const {buildToolDefinitions}=await import('../lib/tools.js');
  const {HindsightClient}=await import('../lib/http.js');
  const stats=fakeRuntime();
  const config=baseConfig({apiUrl:base,retainTimeoutMs:300,operationTimeoutMs:30000,operationPollMs:15});
  const controller=new AbortController();
  const defs=buildToolDefinitions({snapshot:()=>config,clientFor:cfg=>new HindsightClient({...cfg,timeoutMs:300}),statsOf:()=>stats,lifecycleSignal:()=>controller.signal});
  const text=await defs.find(d=>d.name==='hindsight_retain').execute({content:'x'});
  assert.match(text,/已排队/);
  controller.abort(new Error('dispose'));
  await new Promise(r=>setTimeout(r,120));
  assert.equal(stats.pending.size,0,'abort must clear the pending entry');
  assert.equal(stats.stats.completed,0,'aborted poll must not count as completed');
});
