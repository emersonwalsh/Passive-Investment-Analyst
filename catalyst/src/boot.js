/* ============================================================
   BOOT — synchronous, zero imports, zero async. Paints from the
   localStorage mirror in the same tick the HTML parses.
   Mirrored in src/render.js; newtab.js re-renders canonically and
   only touches the DOM if the markup actually differs.
   ============================================================ */
(function(){
var T0=performance.now(), KEY='cache:v1', SV=1;

var c=null;
try{var raw=localStorage.getItem(KEY); if(raw){var p=JSON.parse(raw); if(p&&p.v===SV)c=p;}}catch(e){}

/* theme before paint — no flash */
var theme=(c&&c.theme)||'auto';
if(theme==='dark'||theme==='light')document.documentElement.setAttribute('data-theme',theme);

var DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var MONS=['January','February','March','April','May','June','July','August','September','October','November','December'];
var now=new Date(), T=now.getTime();

/* --- US Eastern without Intl (ICU init is too costly for the boot path) --- */
function etOff(t){
  var y=new Date(t).getUTCFullYear();
  var a=new Date(Date.UTC(y,2,1)).getUTCDay(), s=Date.UTC(y,2,1+((7-a)%7)+7,7);
  var b=new Date(Date.UTC(y,10,1)).getUTCDay(), e=Date.UTC(y,10,1+((7-b)%7),6);
  return (t>=s&&t<e)?-4:-5;
}
function etNow(t){var d=new Date(t+etOff(t)*36e5);return{w:d.getUTCDay(),m:d.getUTCHours()*60+d.getUTCMinutes()};}
function mkt(t){
  var e=etNow(t);
  if(e.w===0||e.w===6)return['Closed',''];
  if(e.m<240||e.m>=1200)return['Closed',''];
  if(e.m<570)return['Pre-market','ext'];
  if(e.m<960)return['Open','open'];
  return['After hours','ext'];
}

/* local calendar day index, DST-proof */
function dnum(y,m,d){return Math.floor(Date.UTC(y,m,d)/864e5);}
var TODAY=dnum(now.getFullYear(),now.getMonth(),now.getDate());
function isoDay(s){var p=s.split('-');return dnum(+p[0],+p[1]-1,+p[2]);}
function rel(n,cf){var t=cf===false?'~':'';return n<0?'past':n===0?t+'today':n===1?t+'tomorrow':'in '+t+n+' days';}
function pastL(n){return n===0?'today':n===-1?'yesterday':(-n)+' days ago';}
function surp(p,act,con){
  if(typeof p!=='number'||!isFinite(p))return null;
  var a=Math.abs(p);
  if(a<0.05)return{text:'in line',dir:'f'};
  var verb=p>0?'beat':'missed', dir=p>0?'u':'d';
  if(typeof act==='number'&&typeof con==='number'&&(Math.abs(con)<0.1||a>=100))
    return{text:verb+' by $'+Math.abs(act-con).toFixed(2),dir:dir};
  return{text:verb+' '+a.toFixed(1)+'%',dir:dir};
}
function sm(v){return (v<0?'&minus;':'')+'$'+Math.abs(v).toFixed(2);}
function esc(s){return String(s).replace(/[&<>"]/g,function(ch){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch];});}

/* header */
document.getElementById('date').textContent=DAYS[now.getDay()]+', '+MONS[now.getMonth()]+' '+now.getDate();
var ms=mkt(T), pill=document.getElementById('mkt');
pill.className='pill '+ms[1]; pill.innerHTML='<span class="dot"></span>'+ms[0];

var upEl=document.getElementById('up'), holdEl=document.getElementById('hold'),
    hwrap=document.getElementById('holdwrap'), updEl=document.getElementById('upd');

/* ---------- no mirror at all: paint nothing yet ----------
   Only the page can write the mirror, so the first tab after install never has
   one even though the worker has already seeded tickers. Painting the empty
   state here showed a seeded user "Add your first stock" for a frame, then
   swung the calendar from full width into the right column (CLS 0.06, measured
   in real Chrome). Leave both regions empty in their normal positions and let
   newtab.js fill them from real storage. */
if(!c){
  updEl.textContent='';
  window.__catalystBoot=performance.now()-T0;
  try{if(localStorage.getItem('catalyst:debug'))console.log('[catalyst] boot %sms (no mirror)',window.__catalystBoot.toFixed(1));}catch(e){}
  return;
}

/* ---------- no tickers: empty state, nothing else ---------- */
if(!c.ready){
  upEl.innerHTML='<div class="empty anim"><h1>What&rsquo;s coming up</h1>'+
    '<p>Passive Investment Analyst shows earnings dates for the stocks you track, every time you open a tab. '+
    'Add a few tickers to get started &mdash; no account needed.</p>'+
    '<button class="btn" id="setup">Add your first stock</button></div>';
  hwrap.className='hide'; updEl.textContent='';
  window.__catalystBoot=performance.now()-T0;
  try{if(localStorage.getItem('catalyst:debug'))console.log('[catalyst] boot %sms',window.__catalystBoot.toFixed(1));}catch(e){}
  return;
}

var syms=c.symbols||[], q=(c.quotes&&c.quotes.data)||{}, cat=(c.catalysts&&c.catalysts.data)||{};
var LBL={earnings:'Earnings',exdiv:'Ex-dividend',lockup:'Lockup expiry'};
var TIM={amc:'after close',bmo:'before open',dmt:'during market'};

/* ---------- coming up ---------- */
var SECI='<h2 class="shd"><svg class="shi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"'+
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
  '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Insider buying</h2>';
function money(v){
  if(typeof v!=='number'||!isFinite(v))return '';
  if(v>=1e9)return '$'+(v/1e9).toFixed(1)+'B';
  if(v>=1e6)return '$'+(v/1e6).toFixed(1)+'M';
  if(v>=1e3)return '$'+Math.round(v/1e3)+'K';
  return '$'+Math.round(v);
}
var INS='';
if(c.showInsiders!==false&&c.insiders&&c.insiders.data){
  var idat=c.insiders.data, flat=[];
  for(var ii=0;ii<syms.length;ii++){
    var hs=idat[syms[ii]]||[];
    for(var hj=0;hj<hs.length;hj++)flat.push({s:syms[ii],h:hs[hj]});
  }
  if(flat.length){
    flat.sort(function(a,b){return b.h.value-a.h.value||(a.s<b.s?-1:1);});
    var irows='', iidx=0;
    for(var ik=0;ik<flat.length&&ik<4;ik++){
      var fs=flat[ik].s, fh=flat[ik].h;
      var stk='';   /* no stake figure: see renderInsiders() in render.js */
      var rol=fh.role?' &middot; '+esc(fh.role):'';
      irows+='<li class="row buy anim" style="--i:'+(iidx++)+'">'+
        '<span class="sym">'+esc(fs)+'</span>'+
        '<span class="evt">'+esc(fh.who)+rol+stk+'</span>'+
        '<span class="rel u">'+money(fh.value)+'</span></li>';
    }
    INS=SECI+'<div class="grp"><ul class="rows">'+irows+'</ul></div>';
  }
}
var res=(c.results&&c.results.data)||{};
var all=[];
for(var i=0;i<syms.length;i++){
  var list=cat[syms[i]]; if(!list)continue;
  for(var j=0;j<list.length;j++){
    var ev=list[j]; if(!ev||!ev.date)continue;
    var n=isoDay(ev.date)-TODAY; if(n>400)continue;
    var rr=res[syms[i]];
    if(n<=0&&rr){all.push({s:syms[i],n:n,t:ev.type,res:rr,reported:true});continue;}
    if(n<0)continue;
    all.push({s:syms[i],n:n,t:ev.type,tm:ev.timing,eps:ev.epsEstimate,cf:ev.confirmed===true});
  }
}
all.sort(function(a,b){return a.n-b.n||(a.s<b.s?-1:1);});
var reported=all.filter(function(x){return x.reported;}).slice(-3).reverse();
var items=all.filter(function(x){return !x.reported;});

var SEC='<h2 class="shd"><svg class="shi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10.5h18"/></svg>Earnings calendar</h2>';
var HIDDEN='<div class="grp anim"><p class="more">Both sections are hidden &mdash; open settings to turn one back on.</p></div>';
var showCat=c.showCatalysts!==false, showPx=c.showPrices!==false;
if(!showCat&&!showPx&&!INS){
  upEl.innerHTML=HIDDEN; hwrap.className='hide'; updEl.textContent='';
  window.__catalystBoot=performance.now()-T0;
  try{if(localStorage.getItem('catalyst:debug'))console.log('[catalyst] boot %sms',window.__catalystBoot.toFixed(1));}catch(e){}
  return;
}

if(!showCat){
  upEl.innerHTML=INS;
  if(!INS)upEl.className='hide';
}else{
var hasCat=!!(c.catalysts&&c.catalysts.fetchedAt);
if(!hasCat&&c.catalysts&&c.catalysts.stale){
  upEl.innerHTML=INS+SEC+'<div class="grp anim"><h3 class="ghd">Next up</h3><ul class="rows">'+
    '<li class="more">Couldn&rsquo;t load earnings dates &mdash; check your API key in settings.</li>'+
    '</ul></div>';
}else if(!hasCat&&!items.length&&!reported.length){
  var sk='';for(var k=0;k<4;k++)sk+='<li class="row sk"><span class="skb w1"></span><span class="skb w2"></span><span class="skb w3"></span></li>';
  upEl.innerHTML=INS+SEC+'<div class="grp"><h3 class="ghd">Next up</h3><ul class="rows">'+sk+'</ul></div>';
}else if(!items.length&&!reported.length){
  upEl.innerHTML=INS+SEC+'<div class="grp anim"><h3 class="ghd">Next up</h3>'+
    '<ul class="rows"><li class="more">No upcoming earnings dates published yet.</li></ul></div>';
}else{
  /* week runs Mon-Sun */
  var dow=now.getDay(), endThis=(dow===0?0:7-dow);
  var g=[[],[],[]];
  for(var m=0;m<items.length;m++){var it=items[m];g[it.n<=endThis?0:it.n<=endThis+7?1:2].push(it);}
  var names=['This week','Next week','Later'], html=INS+SEC, shown=0, CAP=8, idx=0, projected=false;
  if(reported.length){
    var rrows='';
    for(var rp=0;rp<reported.length;rp++){
      var ro=reported[rp], sp=surp(ro.res.surprisePct,ro.res.actual,ro.res.consensus);
      var rdet='EPS '+sm(ro.res.actual)+' vs '+sm(ro.res.consensus)+' est.';
      rrows+='<li class="row rep anim" style="--i:'+(idx++)+'" title="Zacks EPS and consensus; may differ from the company&rsquo;s adjusted figure">'+
        '<span class="sym">'+esc(ro.s)+'</span>'+
        '<span class="evt">'+pastL(ro.n)+'<span class="tm"> &middot; '+rdet+'</span></span>'+
        '<span class="rel '+(sp?sp.dir:'f')+'">'+(sp?sp.text:'&mdash;')+'</span></li>';
    }
    html+='<div class="grp"><h3 class="ghd anim" style="--i:'+(idx++)+'">Just reported</h3>'+
      '<ul class="rows">'+rrows+'</ul></div>';
  }
  for(var gi=0;gi<3;gi++){
    if(!g[gi].length||shown>=CAP)continue;
    var hIdx=idx++, rows='';
    for(var r=0;r<g[gi].length&&shown<CAP;r++,shown++){
      var o=g[gi][r];
      var det=(o.tm&&TIM[o.tm]?' &middot; '+TIM[o.tm]:'')+
        (typeof o.eps==='number'&&isFinite(o.eps)
          ? ' &middot; est. '+(o.eps<0?'&minus;':'')+'$'+Math.abs(o.eps).toFixed(2) : '');
      var tmx=det?'<span class="tm">'+det+'</span>':'';
      var heat=o.n<=1?' now':o.n<=5?' soon':'';
      var mark=o.n<=1?'<span class="pip" aria-hidden="true"></span>':'';
      if(!o.cf)projected=true;
      rows+='<li class="row anim'+heat+'" style="--i:'+(idx++)+'">'+
        mark+'<span class="sym">'+esc(o.s)+'</span><span class="evt">'+(LBL[o.t]||'Event')+tmx+'</span>'+
        (o.cf
          ?'<span class="rel">'+rel(o.n)+'</span></li>'
          :'<span class="rel est" title="Projected from past reporting dates">'+rel(o.n,false)+
            '<span class="vh"> (projected from past reporting dates)</span></span></li>');
    }
    html+='<div class="grp"><h3 class="ghd anim" style="--i:'+hIdx+'">'+names[gi]+'</h3><ul class="rows">'+rows+'</ul></div>';
  }
  if(items.length>shown)html+='<div class="more anim" style="--i:'+idx+'">+'+(items.length-shown)+' more</div>';
  if(projected)html+='<p class="fn anim">~ Projected from past reporting dates, so likely to move.</p>';
  upEl.innerHTML=html;
  // every symbol may have just reported, leaving no upcoming item at all
  if(items.length&&items[0].n<=7)document.body.style.setProperty('--heat',String(Math.max(0,1-items[0].n/7).toFixed(2)));
}
}

/* ---------- holdings ---------- */
function spark(pts,pc,dir){
  if(!Array.isArray(pts)||pts.length<2)return '<div class="sparkph"></div>';
  var W=100,H=30,pad=2,min=Infinity,max=-Infinity,i;
  for(i=0;i<pts.length;i++){if(pts[i]<min)min=pts[i];if(pts[i]>max)max=pts[i];}
  if(pc!=null){if(pc<min)min=pc;if(pc>max)max=pc;}
  var span=(max-min)||1;
  function yv(v){return (H-pad-((v-min)/span)*(H-pad*2)).toFixed(1);}
  var step=W/(pts.length-1),d='';
  for(i=0;i<pts.length;i++)d+=(i?'L':'M')+(i*step).toFixed(1)+' '+yv(pts[i]);
  var base=pc==null?'':'<line class="spb" x1="0" y1="'+yv(pc)+'" x2="'+W+'" y2="'+yv(pc)+'"/>';
  return '<svg class="spark '+dir+'" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" aria-hidden="true">'+
    base+'<path class="spf" d="'+d+'L'+W+' '+H+'L0 '+H+'Z"/><path class="spl" d="'+d+'"/></svg>';
}
function cn(n){
  var raw=String(n||'');
  var s=raw.replace(/\s+(?:Class\s+[A-Z]\s+)?(?:New\s+)?(?:Common|Ordinary|Capital|Subordinate\s+Voting)\s+(?:Stock|Shares)(?:\s*\([^)]*\))?\s*$/i,'')
    .replace(/\s+American\s+Depositary\s+(?:Shares?|Receipts?)(?:\s*\([^)]*\))?\s*$/i,'').trim();
  return s||raw;
}
function lhue(sym){var h=0;for(var i=0;i<sym.length;i++)h=(h*31+sym.charCodeAt(i))%360;return h;}
function lmark(sym,inf){
  var src=inf&&typeof inf.logo==='string'&&inf.logo.indexOf('data:image/')===0?inf.logo:null;
  return src?'<img class="clogo" src="'+src+'" alt="" width="18" height="18">'
    :'<span class="clogo mono" style="--h:'+lhue(sym)+'">'+esc(sym.slice(0,2))+'</span>';
}
var ADD='<button class="cell add" id="addcard" aria-label="Add a stock">'+
  '<span class="addg">+</span><span class="addt">Add stock</span></button>';
var ADD_FULL='<div class="cell add off" aria-disabled="true"><span class="addt">25 ticker limit</span></div>';

if(!showPx){hwrap.className='hide';}
else{
  var ser=(c.series&&c.series.data)||{}, meta=c.meta||{}, hh='';
  var fs=(c.quotes&&c.quotes.fetchingSince)||0;
  var xph=(c.quotes&&c.quotes.extPhase)||null, xlbl=xph==='pre'?'Pre':'AH';
  var anyExt=false;
  for(var ax=0;ax<syms.length;ax++){ if(q[syms[ax]]&&q[syms[ax]].ext){anyExt=true;break;} }
  function xline(d){
    var e=d&&d.ext;
    if(!e||e.price==null)return '<span class="cext"><em>'+xlbl+'</em>&mdash;</span>';
    var xd=e.changePct>0?'u':e.changePct<0?'d':'f', xs=e.changePct>0?'+':'';
    return '<span class="cext"><em>'+xlbl+'</em>'+e.price.toFixed(2)+
      ' <b class="'+xd+'">'+xs+e.changePct.toFixed(2)+'%</b></span>';
  }
  var pending=(fs&&(T-fs)<30000)||!(c.quotes&&c.quotes.fetchedAt);
  var srt=c.sort||{by:'change',dir:'desc'};
  var sby=srt.by==='name'?'name':'change', sdir=srt.dir==='asc'?1:-1;
  var ord=syms.slice().sort(function(a,b){
    var da=q[a], db=q[b];
    var ha=da&&da.price!=null?0:1, hb=db&&db.price!=null?0:1;
    if(ha!==hb)return ha-hb;
    if(sby==='name'){
      var na=((meta[a]&&meta[a].name)||a).toLowerCase(), nb=((meta[b]&&meta[b].name)||b).toLowerCase();
      if(na!==nb)return (na<nb?-1:1)*sdir;
    }else{
      var ca=da&&typeof da.changePct==='number'?da.changePct:-Infinity;
      var cb=db&&typeof db.changePct==='number'?db.changePct:-Infinity;
      if(ca!==cb)return (ca-cb)*sdir;
    }
    return a<b?-1:1;
  });
  for(var x=0;x<ord.length;x++){
    var s2=ord[x], d2=q[s2], inf=meta[s2]||{};
    var act='<span class="cact">'+
      '<a class="ca gf" href="'+(inf.exchange
        ?'https://www.google.com/finance/quote/'+encodeURIComponent(s2)+':'+inf.exchange
        :'https://www.google.com/search?q='+encodeURIComponent(s2)+'+stock')+'" target="_blank" rel="noreferrer noopener"'+
      ' aria-label="Open '+esc(s2)+' in Google Finance" title="Google Finance">&#8599;</a>'+
      '<button class="ca" data-rm="'+esc(s2)+'" aria-label="Remove '+esc(s2)+'" title="Remove">&times;</button>'+
      '</span>';
    if(!d2||d2.price==null){
      hh+=pending
        ?'<div class="cell sk" data-s="'+esc(s2)+'"><div class="chd">'+lmark(s2,inf)+'<span class="csym">'+esc(s2)+'</span>'+act+'</div>'+
          '<span class="cnm">'+esc(cn(inf.name))+'</span><span class="cpx skl"><i class="skb"></i></span>'+
          '<span class="cch pend">Fetching&hellip;</span><div class="sparkph"></div></div>'
        :'<div class="cell nod" data-s="'+esc(s2)+'"><div class="chd">'+lmark(s2,inf)+'<span class="csym">'+esc(s2)+'</span>'+act+'</div>'+
          '<span class="cnm">'+esc(cn(inf.name))+'</span><span class="cpx">&mdash;</span>'+
          '<span class="cch">'+((c.quotes&&c.quotes.unknown&&c.quotes.unknown[s2])?'Not a ticker':'No data')+
          '</span><div class="sparkph"></div></div>';
      continue;
    }
    var cp2=d2.changePct, dir2=cp2>0?'u':cp2<0?'d':'f', sg2=cp2>0?'+':'';
    var net=d2.prevClose==null?null:d2.price-d2.prevClose;
    var netS=net==null?'':'<span class="cnet">('+(net>0?'+':'')+net.toFixed(2)+')</span> ';
    var nm=inf.name?'<span class="cnm">'+esc(cn(inf.name))+'</span>':'<span class="cnm"></span>';
    hh+='<div class="cell" data-s="'+esc(s2)+'"><div class="chd">'+lmark(s2,inf)+'<span class="csym">'+esc(s2)+'</span>'+act+'</div>'+
      nm+'<span class="cpx">'+d2.price.toFixed(2)+'</span>'+
      '<span class="cch '+dir2+'">'+netS+(cp2==null?'&mdash;':sg2+cp2.toFixed(2)+'%')+'</span>'+
      (anyExt?xline(d2):'')+spark(ser[s2],d2.prevClose,dir2)+'</div>';
  }
  holdEl.innerHTML=hh+(syms.length>=25?ADD_FULL:ADD);
}

/* ---------- footer ---------- */
var qfs=(c.quotes&&c.quotes.fetchingSince)||0;
var fa=(c.quotes&&c.quotes.fetchedAt)||(c.catalysts&&c.catalysts.fetchedAt)||0;
var busy=qfs&&(T-qfs)<30000;
if(busy&&!fa){
  updEl.textContent='Updating\u2026';
}else if(fa){
  var mn=Math.floor((T-fa)/6e4), ago=mn<1?'just now':mn<60?mn+' min ago':mn<1440?Math.floor(mn/60)+' hr ago':Math.floor(mn/1440)+' d ago';
  var qr=(c.quotes&&c.quotes.reason)||null;
  var why=!c.stale?'':qr==='rate'?' \u00b7 rate limited':qr==='auth'?' \u00b7 key rejected':
    qr==='blocked'?' \u00b7 data source unavailable':' \u00b7 offline';
  updEl.textContent='Updated '+ago+(why||(busy?' \u00b7 updating':''));
}

window.__catalystBoot=performance.now()-T0;
try{if(localStorage.getItem('catalyst:debug'))console.log('[catalyst] boot %sms',window.__catalystBoot.toFixed(1));}catch(e){}
})();
