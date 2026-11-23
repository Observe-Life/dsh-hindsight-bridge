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
