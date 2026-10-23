export interface Match{id:number,sport:string,league:string,country:string,home:string,away:string,kickoff:string,live:boolean,minute:number,hs:number,as:number,marketsCount:number,odds:{sel:string,price:number}[]}
export const sportsDetailed=[
 {id:14,name:'Football',sw:'Mpira wa Miguu',count:128},{id:1,name:'Basketball',sw:'Mpira wa Kikapu',count:42},
 {id:2,name:'Tennis',sw:'Tenisi',count:36},{id:3,name:'Cricket',sw:'Kriketi',count:18},{id:4,name:'Rugby',sw:'Raga',count:14},
 {id:5,name:'Volleyball',sw:'Mpira wa Wavu',count:16},{id:6,name:'Ice Hockey',sw:'Hoki ya Barafu',count:22},
 {id:7,name:'Table Tennis',sw:'Tenisi ya Meza',count:20},{id:8,name:'Boxing',sw:'Ndondi',count:8},
 {id:9,name:'American Football',sw:'Soka ya Marekani',count:12},{id:10,name:'Baseball',sw:'Baseball',count:15},
 {id:11,name:'Handball',sw:'Handiboli',count:11},{id:12,name:'eSoccer',sw:'eSoccer',count:24},
 {id:13,name:'Counter-Strike',sw:'Counter-Strike',count:9},{id:15,name:'Darts',sw:'Darts',count:7},
 {id:16,name:'MMA',sw:'MMA',count:6},{id:17,name:'Badminton',sw:'Badminton',count:10},{id:18,name:'Futsal',sw:'Futsal',count:13}];
export const sports=sportsDetailed.map(s=>s.name);
const iso=(h:number)=>new Date(Date.now()+h*3600e3).toISOString();
export let matches:Match[]=[
 {id:1,sport:'Football',league:'Ligi Kuu Tanzania (mock)',country:'Tanzania',home:'Simba SC',away:'Yanga SC',kickoff:iso(-1),live:true,minute:56,hs:1,as:1,marketsCount:84,odds:[{sel:'1',price:2.4},{sel:'X',price:3.0},{sel:'2',price:2.9}]},
 {id:2,sport:'Football',league:'Ligi Kuu Tanzania (mock)',country:'Tanzania',home:'Azam FC',away:'Singida BS',kickoff:iso(-2),live:true,minute:23,hs:1,as:0,marketsCount:76,odds:[{sel:'1',price:1.85},{sel:'X',price:3.3},{sel:'2',price:4.1}]},
 {id:3,sport:'Football',league:'Ligi za Ulaya (mfano)',country:'International',home:'Arsenal',away:'Chelsea',kickoff:iso(3),live:false,minute:0,hs:0,as:0,marketsCount:92,odds:[{sel:'1',price:2.1},{sel:'X',price:3.4},{sel:'2',price:3.2}]},
 {id:4,sport:'Basketball',league:'NBA (mock feed)',country:'USA',home:'LA Lakers',away:'Boston Celtics',kickoff:iso(8),live:false,minute:0,hs:0,as:0,marketsCount:48,odds:[{sel:'1',price:1.9},{sel:'2',price:1.9}]},
 {id:5,sport:'Tennis',league:'ATP (mock feed)',country:'International',home:'C. Alcaraz',away:'J. Sinner',kickoff:iso(20),live:false,minute:0,hs:0,as:0,marketsCount:32,odds:[{sel:'1',price:1.75},{sel:'2',price:2.05}]},
 {id:6,sport:'Football',league:'Ligi za Ulaya (mfano)',country:'International',home:'Real Madrid',away:'FC Barcelona',kickoff:iso(28),live:false,minute:0,hs:0,as:0,marketsCount:95,odds:[{sel:'1',price:2.5},{sel:'X',price:3.5},{sel:'2',price:2.6}]},
 {id:7,sport:'Cricket',league:'T20 (mock)',country:'Tanzania',home:'Tanzania XI',away:'Kenya XI',kickoff:iso(5),live:false,minute:0,hs:0,as:0,marketsCount:28,odds:[{sel:'1',price:1.95},{sel:'2',price:1.85}]},
 {id:8,sport:'Volleyball',league:'Volleyball TZ (mock)',country:'Tanzania',home:'Dar Volley',away:'Arusha Spikers',kickoff:iso(-1),live:true,minute:41,hs:2,as:1,marketsCount:18,odds:[{sel:'1',price:1.7},{sel:'2',price:2.1}]},
 {id:9,sport:'eSoccer',league:'eSoccer Ligi (mock)',country:'Virtual',home:'eSimba',away:'eYanga',kickoff:iso(1),live:false,minute:0,hs:0,as:0,marketsCount:22,odds:[{sel:'1',price:2.2},{sel:'X',price:3.1},{sel:'2',price:2.8}]},
 {id:10,sport:'Counter-Strike',league:'CS Map 1 (mock)',country:'Esports',home:'Team Dar',away:'Team Nairobi',kickoff:iso(6),live:false,minute:0,hs:0,as:0,marketsCount:16,odds:[{sel:'1',price:1.8},{sel:'2',price:1.95}]},
];
export function moreMatches(offset:number):Match[]{const teams:[string,string][]=[['Coastal Union','Dodoma Jiji'],['Namungo FC','Kagera Sugar'],['Mbeya City','Prisons SC'],['Mashujaa FC','Tabora United']];return teams.map((t,i)=>({id:100+offset+i,sport:'Football',league:'Ligi Kuu Tanzania (mock)',country:'Tanzania',home:t[0],away:t[1],kickoff:iso(10+offset+i*4),live:false,minute:0,hs:0,as:0,marketsCount:64+i*3,odds:[{sel:'1',price:+(2+((offset+i)%5)*0.2).toFixed(2)},{sel:'X',price:3.1},{sel:'2',price:+(2.6+((offset+i)%3)*0.3).toFixed(2)}]}))}
export const fmt=(n:number)=>'TZS '+Math.round(n).toLocaleString('en-US');
export const fmtTime=(isoStr:string)=>new Intl.DateTimeFormat('sw-TZ',{timeZone:'Africa/Dar_es_Salaam',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(isoStr));
export const casinoGames=['Mizunguko ya Dhahabu','Kadi za Bahati','Roulette ya Dar','Matunda Mix','Blackjack TZ','Mines','Aviator-style (original)','Slots za Safari'];
export const promos=[{sw:'Karibu: 100% hadi TZS 50,000 (bonus, wagering x5)',en:'Welcome: 100% up to TZS 50,000 (bonus, wagering x5)'},{sw:'Cashback ya Jumatatu 10%',en:'Monday 10% cashback'},{sw:'Odds Boost kwenye Ligi Kuu',en:'Ligi Kuu odds boost'}];
// Hero media is a still image. The player site does not use video.
export type HeroMedia={type:'image',src:string};
export interface HeroSlide{swTitle:string,swBody:string,enTitle:string,enBody:string,media:HeroMedia,duration?:number}
export const heroSlides:HeroSlide[]=[{swTitle:'Bonasi ya Amana ya Kwanza',swBody:'Anza na ofa ya karibu ya Ushindi — masharti wazi, wagering kwenye bonasi tu.',enTitle:'First Deposit Bonus',enBody:'Start with Ushindi welcome offer — clear terms, wagering on bonus only.',media:{type:'image',src:'/hero/deposit-bonus.svg'}},{swTitle:'Cashout Wakati Unataka',swBody:'Funga beti yako mapema mechi ikiwa mubashara.',enTitle:'Cash Out When You Choose',enBody:'Settle your bet early while the match is live.',media:{type:'image',src:'/hero/cashout.svg'}},{swTitle:'Kubeti Mubashara',swBody:'Odds zinazobadilika kila dakika kwenye mechi zinazoendelea.',enTitle:'Live Betting',enBody:'Odds that move every minute on matches in play.',media:{type:'image',src:'/hero/cashout.svg'},duration:9000},{swTitle:'Crash — Cheza kwa Uwazi',swBody:'Mchezo wa kuanguka wenye uthibitisho wa haki, RTP 97% iliyochapishwa.',enTitle:'Crash — Play Fair',enBody:'Provably fair crash game, published 97% RTP.',media:{type:'image',src:'/hero/crash.svg'},duration:6000}];
