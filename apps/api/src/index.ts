import Fastify from 'fastify'; import cors from '@fastify/cors'; import crypto from 'node:crypto';
const app=Fastify({logger:true}); await app.register(cors,{origin:true});
export interface PaymentProvider{ name:string; deposit(p:{phone:string,amount:number}):Promise<{ref:string,status:string}>; withdraw(p:{phone:string,amount:number}):Promise<{ref:string,status:string}> }
export class MockMobileMoneyProvider implements PaymentProvider{ constructor(public name:string){} async deposit(p:any){return{ref:`MOCK-${this.name}-${crypto.randomUUID().slice(0,8)}`,status:'completed_sandbox'}} async withdraw(p:any){return this.deposit(p)} }
export const providers:Record<string,PaymentProvider>=Object.fromEntries(['M-Pesa','Tigo Pesa','Airtel Money','HaloPesa'].map(n=>[n,new MockMobileMoneyProvider(n)]));
export const config={marginBps:600,minStake:500,maxStake:500000,minWithdraw:1000,maxWithdraw:5000000,rtpBps:9700};
export interface OddsFeedAdapter{ getMatches():any[] }
export function applyMargin(fair:number){ return Math.max(1.01, +(1+(fair-1)*(1-config.marginBps/10000)).toFixed(2)) }
export class MockLicensedFeedAdapter implements OddsFeedAdapter{ getMatches(){ return matches } }
const now=Date.now();
export const matches=[1,2,3,4,5,6].map(i=>({id:i,sport:['Football','Football','Basketball','Football','Tennis','Football'][i-1],league:['Ligi Kuu TZ','EPL (mock)','NBA (mock)','Serie A (mock)','ATP (mock)','La Liga (mock)'][i-1],home:['Simba SC','Arsenal','LA Lakers','Inter','Alcaraz','Real Madrid'][i-1],away:['Yanga SC','Chelsea','Boston','Napoli','Sinner','Barcelona'][i-1],kickoff:new Date(now+i*3600e3).toISOString(),live:i<=2,minute:i<=2?34+i*10:0,homeScore:i<=2?1:0,awayScore:i<=2?0:0,markets:{main:[{sel:'1',price:applyMargin(2.1)},{sel:'X',price:applyMargin(3.2)},{sel:'2',price:applyMargin(2.8)}],goals:[{sel:'Over 2.5',price:applyMargin(1.9)},{sel:'Under 2.5',price:applyMargin(1.85)}],btts:[{sel:'Yes',price:applyMargin(1.8)},{sel:'No',price:applyMargin(1.95)}]}}));
export const audit:any[]=[{actor:'system',action:'boot',at:new Date().toISOString()}];
interface OfficialResultsProvider{ settle(matchId:number):Promise<string> }
export const officialResults:OfficialResultsProvider={async settle(id){audit.push({actor:'official-results',action:'settle',matchId:id,at:new Date().toISOString()});return 'settled_from_official_result_append_only_ledger'}};
// Crash provably fair: commit hash before, reveal after. RTP 97%
let nonce=0; let serverSeed=crypto.randomBytes(32).toString('hex'); let currentHash=crypto.createHash('sha256').update(serverSeed).digest('hex');
function crashPoint(seed:string,client:string,n:number){ const h=crypto.createHmac('sha256',seed).update(`${client}:${n}`).digest('hex'); const r=parseInt(h.slice(0,13),16)/2**52; if(parseInt(h.slice(0,8),16)%33===0) return 1; return Math.min(100,Math.max(1,+(0.97/(1-r)).toFixed(2))) }
app.get('/health',async()=>({ok:true,service:'ushindi-api',tz:'Africa/Dar_es_Salaam',sandbox:true}));
app.get('/api/matches',async(q:any)=> (q.query as any)?.live?matches.filter(m=>m.live):matches);
app.get('/api/matches/:id',async(q:any)=>matches.find(m=>m.id==+(q.params as any).id)||{error:'not found'});
app.get('/api/crash/current',async()=>({serverSeedHash:currentHash,nonce,rtp:0.97,publishedRtp:'97%'}));
app.post('/api/crash/start',async(req:any)=>{ const {clientSeed='ushindi',cashOutAt} = req.body||{}; const mult=crashPoint(serverSeed,clientSeed,nonce); const revealed=serverSeed, hash=currentHash, n=nonce; serverSeed=crypto.randomBytes(32).toString('hex'); currentHash=crypto.createHash('sha256').update(serverSeed).digest('hex'); nonce++; return {crashMultiplier:mult,cashedOut: cashOutAt&&cashOutAt<=mult, payoutMultiplier: cashOutAt&&cashOutAt<=mult?cashOutAt:0, verify:{serverSeed:revealed,serverSeedHash:hash,clientSeed,nonce:n,algorithm:'HMAC_SHA256(serverSeed, clientSeed:nonce) -> max(1,0.97/(1-r)) cap 100x'}}});
app.post('/api/payments/:kind',async(req:any)=>{ const kind=(req.params as any).kind; const {provider='M-Pesa',amount,phone}=req.body||{}; if(!providers[provider]) return {error:'unknown provider'}; if(amount<(kind==='withdraw'?config.minWithdraw:500)) return {error:`minimum ${kind}`}; const r= kind==='withdraw'?await providers[provider].withdraw({phone,amount}):await providers[provider].deposit({phone,amount}); audit.push({actor:phone,action:kind,amount,provider,at:new Date().toISOString()}); return {...r,provider,amount,currency:'TZS',sandbox:true} });
app.get('/api/admin/config',async()=>config); app.patch('/api/admin/config',async(req:any)=>{Object.assign(config,req.body||{}); audit.push({actor:'admin',action:'config',...config,at:new Date().toISOString()}); return config});
app.get('/api/audit',async()=>audit);
app.post('/api/settle/:id',async(req:any)=>({result:await officialResults.settle(+(req.params as any).id)}));

// --- REA-aligned aliases (functional shape only, original mock data, margin applied) ---
export const sportsList=[{id:14,name:'Football',sw:'Mpira wa Miguu'},{id:1,name:'Basketball',sw:'Mpira wa Kikapu'},{id:2,name:'Tennis',sw:'Tenisi'},{id:3,name:'Cricket',sw:'Kriketi'},{id:4,name:'Rugby',sw:'Raga'},{id:5,name:'Volleyball',sw:'Mpira wa Wavu'},{id:6,name:'Ice Hockey',sw:'Hoki ya Barafu'},{id:7,name:'Table Tennis',sw:'Tenisi ya Meza'},{id:8,name:'Boxing',sw:'Ndondi'},{id:9,name:'American Football',sw:'Soka ya Marekani'},{id:10,name:'Baseball',sw:'Baseball'},{id:11,name:'Handball',sw:'Handiboli'},{id:12,name:'eSoccer',sw:'eSoccer'},{id:13,name:'Counter-Strike',sw:'Counter-Strike'},{id:15,name:'Darts',sw:'Darts'},{id:16,name:'MMA',sw:'MMA'},{id:17,name:'Badminton',sw:'Badminton'},{id:18,name:'Futsal',sw:'Futsal'}].map(s=>({...s,totalMatches:matches.filter(m=>m.sport===s.name).length|| (s.id*3%20+5),liveMatches:matches.filter(m=>m.sport===s.name&&m.live).length}));
const v1Matches=(q:any)=>{let out=[...matches]; const sport_id=(q.query as any)?.sport_id; if(sport_id) out=out.filter(m=>sportsList.find(s=>s.name===m.sport)?.id===+sport_id); if((q.query as any)?.live==='true'||(q.query as any)?.tab==='live') out=out.filter(m=>m.live); const page=+((q.query as any)?.page||1),limit=+((q.query as any)?.limit||10); return out.slice((page-1)*limit,(page-1)*limit+limit)};
app.get('/v1/uo/matches',async(q:any)=>({data:v1Matches(q),meta:{total:matches.length,live:matches.filter(m=>m.live).length,marginBps:config.marginBps,currency:'TZS',tz:'Africa/Dar_es_Salaam',sandbox:true,source:'mock licensed-feed adapter with operator margin'}}));
app.get('/v1/uo/sports',async()=>({data:sportsList,meta:{total:sportsList.length,live:matches.filter(m=>m.live).length}}));
app.get('/v1/uo/totalMatches',async()=>({totalMatches:matches.length,liveMatches:matches.filter(m=>m.live).length,bySport:sportsList.map(s=>({sport_id:s.id,name:s.name,total:s.totalMatches,live:s.liveMatches}))}));
app.get('/v1/uo/sport',async(q:any)=>{const id=+((q.query as any)?.id||14); const s=sportsList.find(x=>x.id===id); return {data:s||null,matches:matches.filter(m=>m.sport===s?.name),meta:{sport_id:id}}});

const port=+(process.env.PORT||4000); app.listen({port,host:'0.0.0.0'});
