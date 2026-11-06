const DV=window.DataValidation;
if(!DV){document.body.innerHTML='<div style="padding:24px;color:#c0563f;font-family:Tahoma,sans-serif">تعذر تحميل وحدة التحقق من المعطيات. لم يتم تعديل أي ملف.</div>';throw new Error("DataValidation missing")}
const ACT=DV.ACT;
const LV=["الأول ابتدائي","الثاني ابتدائي","الثالث ابتدائي","الرابع ابتدائي","الخامس ابتدائي","السادس ابتدائي","الأولى إعدادي","الثانية إعدادي","الثالثة إعدادي","الجذع المشترك","الأولى باك","الثانية باك","جامعي","بالغ"];
const TABS=[["dash","لوحة القيادة"],["stu","التلاميذ"],["att","الحضور"],["pay","الأداءات"],["tar","التعريفة"],["bc","رسائل"]];
const IS_ELECTRON=/Electron/i.test(navigator.userAgent);
const DESKTOP=window.desktop;
const MAX_MONEY=DV.MAX_MONEY,MAX_PAYMENT_MONTHS=DV.MAX_PAYMENT_MONTHS,MAX_CALC_MONTHS=12000;
function validFee(v){return Number.isFinite(v)&&v>=0&&v<=MAX_MONEY}
function paymentMonths(v){if(v===""||v===undefined||v===null)return 1;const n=Number(v);return Number.isInteger(n)&&n>=1&&n<=MAX_PAYMENT_MONTHS?n:null}
function paymentAmount(r,n){if(!r||!n)return"";const v=r.fee*n;return Number.isFinite(v)&&v>=0&&v<=MAX_MONEY?String(v):""}
function paymentDate(){const el=$("#pd");if(!el)return today();return DV.validDate(el.value)?el.value:null}
function incomeForMonth(m,pays){return (pays||D.pays).filter(p=>String((p&&p.date)||"").slice(0,7)===m).reduce((a,p)=>a+p.amt,0)}
function defaultData(){return {students:[],regs:[],att:{},pays:[],prices:{},subjects:[],cfg:{name:"تسيير المركز",logo:""}}}
let D=defaultData(),tab="dash",sel=null,msg="";
let loadBlocked=false,loadErrorTitle="",loadError="",saveError="",restoring=false,lastSaved=null,saveSeq=0,savedSeq=0;
function snap(v){return JSON.parse(JSON.stringify(v))}
function remember(){lastSaved=snap(D)}
function rollback(){D=snap(lastSaved||defaultData());if(sel&&!D.students.some(s=>s.id===sel))sel=null;cf=null}
let inFlight=[],shuttingDown=false,shutdownPromise=null;
function trackAction(result){
 if(!result||typeof result.then!=="function")return result;
 const p=Promise.resolve(result);
 inFlight.push(p);
 const done=()=>{const i=inFlight.indexOf(p);if(i>=0)inFlight.splice(i,1)};
 p.then(done,done);
 return result;
}
async function waitForInFlight(){
 while(inFlight.length)await Promise.allSettled(inFlight.slice());
}
function closeForShutdown(){
 if(shutdownPromise)return shutdownPromise;
 shuttingDown=true;
 shutdownPromise=waitForInFlight().then(()=>{if(DESKTOP&&typeof DESKTOP.closeReady==="function")DESKTOP.closeReady()});
 return shutdownPromise;
}
function blockLoad(title,detail){loadBlocked=true;loadErrorTitle=title;loadError=detail||"";D=defaultData();sel=null;msg="";render()}
async function startup(){
 loadBlocked=false;loadErrorTitle="";loadError="";clearSaveError();
 if(IS_ELECTRON){
  if(!DESKTOP||typeof DESKTOP.load!=="function"||typeof DESKTOP.save!=="function"){blockLoad("تعذر الاتصال بطبقة حفظ الملفات","لم يتم تحميل أي معطيات من المتصفح، ولم يتم تعديل ملف data.json.");return}
  let res;
  try{res=await DESKTOP.load()}catch(e){blockLoad("تعذر تحميل المعطيات","لم يتم تعديل ملف data.json.");return}
  if(!res||!res.ok){blockLoad("تعذر تحميل المعطيات",(res&&res.error)||"لم يتم تعديل ملف data.json.");return}
  if(res.firstRun){D=defaultData();remember();return}
  const check=DV.validateData(res.data,{mode:"load"});
  if(!check.ok){blockLoad("ملف المعطيات غير صالح",check.error);return}
  D=check.data;remember();return;
 }
 let raw=null;
 try{raw=localStorage.getItem("centre_v1")}catch(e){blockLoad("تعذر قراءة المعطيات المحلية","لم يتم حفظ أي تغيير.");return}
 if(raw===null){D=defaultData();remember();return}
 let parsed;
 try{parsed=JSON.parse(raw)}catch(e){blockLoad("ملف المعطيات المحلي غير صالح","لم يتم حفظ أي تغيير.");return}
 const check=DV.validateData(parsed,{mode:"load"});
 if(!check.ok){blockLoad("ملف المعطيات المحلي غير صالح",check.error);return}
 D=check.data;remember();
}
async function reloadFromStore(){
 await startup();
 render();
 return !loadBlocked;
}
function showStartupError(){
 blockLoad("تعذر تحميل المعطيات","حدث خطأ غير متوقع أثناء تحميل المعطيات. لم يتم تعديل ملف المعطيات. جرب إعادة المحاولة.");
}
function showSaveError(){
 let e=document.getElementById("save-error");
 if(!saveError){if(e)e.remove();return}
 if(!e){e=document.createElement("div");e.id="save-error";e.style.cssText="position:fixed;top:0;left:0;right:0;background:#c0563f;color:#fff;padding:10px 14px;text-align:center;z-index:20;font-weight:700;box-shadow:0 2px 10px rgba(0,0,0,.2)";document.body.appendChild(e)}
 e.textContent=saveError;
}
function failSave(message){saveError=message;showSaveError()}
function clearSaveError(){if(!saveError)return;saveError="";showSaveError()}
async function save(){
 const id=++saveSeq;
 if(loadBlocked){failSave("الحفظ موقوف لحماية البيانات. أصلح الملف الأصلي أو استرجع نسخة موثوقة.");return false}
 const json=JSON.stringify(D);
 if(IS_ELECTRON){
  if(!DESKTOP||typeof DESKTOP.save!=="function"){if(id===saveSeq)failSave("تعذر الاتصال بطبقة حفظ الملفات. لم يتم حفظ أي تغيير.");return false}
  let res;
  try{res=await DESKTOP.save(json)}catch(e){if(id===saveSeq)failSave("تعذر حفظ المعطيات. لم يتم تعديل الملف الأصلي.");return false}
  if(!res||!res.ok){if(id===saveSeq)failSave((res&&res.error)||"تعذر حفظ المعطيات. لم يتم تعديل الملف الأصلي.");return false}
  if(id>savedSeq){lastSaved=JSON.parse(json);savedSeq=id}
  if(id===saveSeq)clearSaveError();
  return true;
 }
 const check=DV.validateData(D,{mode:"load"});
 if(!check.ok){if(id===saveSeq)failSave("بيانات غير صالحة. لم يتم حفظ أي تغيير.");return false}
 try{localStorage.setItem("centre_v1",json);if(id>savedSeq){lastSaved=JSON.parse(json);savedSeq=id}if(id===saveSeq)clearSaveError();return true}
 catch(e){if(id===saveSeq)failSave("تعذر الحفظ في هذا المتصفح. لم يتم حفظ أي تغيير.");return false}
}
async function persist(){
 const id=saveSeq+1;
 const ok=await save();
 if(!ok&&id===saveSeq){rollback();render()}
 return ok
}
const $=s=>document.querySelector(s);
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,5);
const today=()=>DV.localDate(new Date());
const esc=s=>DV.escapeHtml(s);
const jsv=value=>esc(JSON.stringify(String(value===undefined||value===null?"":value)));
const sName=id=>(D.students.find(s=>s.id===id)||{name:"؟"}).name;
const rLabel=r=>r.act+" – "+r.sub+(r.lvl?" ("+r.lvl+")":"");
const opts=a=>a.map(x=>`<option>${esc(x)}</option>`).join("");
const optsVals=a=>a.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
const optsSel=(a,s)=>{const list=(s&&!a.includes(s))?[s].concat(a):a;return list.map(x=>`<option${x===s?" selected":""}>${esc(x)}</option>`).join("")};
const month=()=>today().slice(0,7);
function mAdd(m,i){const p=String(m||"").split("-");if(p.length<2||!p[0]||!p[1])return String(m||"");const y=Number(p[0]),mo=Number(p[1]),d=new Date(y,mo-1+i,1);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")}
let dM=month(),cf=null,fx=0,pendImp=null,subFormOpen=false,subEdit=null;
function cu(){document.querySelectorAll(".st b").forEach(b=>{const t=parseFloat(b.textContent);if(isNaN(t)||t===0)return;const s=performance.now();(function f(n){const p=Math.min((n-s)/700,1);b.textContent=p<1?Math.round(t*p):t;if(p<1)requestAnimationFrame(f)})(s)})}
function ask(k,fn){if(cf===k){cf=null;fn()}else{cf=k;render()}}
const dp=id=>`<button class="s no" data-action="ask-delete-payment" data-id="${esc(id)}">${cf==="p"+id?"تأكيد الحذف":"حذف"}</button>`;
const MN=["يناير","فبراير","مارس","أبريل","ماي","يونيو","يوليوز","غشت","شتنبر","أكتوبر","نونبر","دجنبر"];
function endD(r){if(!r.fee)return"-";const tot=D.pays.filter(p=>p.rid===r.id).reduce((a,p)=>a+p.amt,0),k=Math.floor(tot/r.fee+1e-9);if(!Number.isFinite(k)||!Number.isSafeInteger(k)||k<0||k>MAX_CALC_MONTHS)return'<span class="no">قيمة غير صالحة</span>';if(!k)return'<span class="no">لم يؤد</span>';const[y,m,d]=r.date.split("-").map(Number),e=new Date(y,m-1,d+30*k);return esc(String(e.getDate()).padStart(2,"0")+"/"+String(e.getMonth()+1).padStart(2,"0")+"/"+e.getFullYear())}
function stat(r){const tot=D.pays.filter(p=>p.rid===r.id).reduce((a,p)=>a+p.amt,0),fee=r.fee||0,[y,m,d]=r.date.split("-").map(Number),[ty,tm,td]=today().split("-").map(Number),days=Math.round((new Date(ty,tm-1,td)-new Date(y,m-1,d))/864e5),k=fee?Math.floor(tot/fee+1e-9):0,cur=days<0?-1:Math.floor(days/30);return{tot,fee,y,m,d,k,cur,owed:fee?Math.max(0,Math.round((cur+1)*fee-tot)):0}}
function mst(r){const s=stat(r);if(!r.fee)return"-";const last=Math.max(s.cur,s.k-1);if(!Number.isFinite(last)||!Number.isSafeInteger(last))return'<span class="no">قيمة غير صالحة</span>';if(last<0)return"-";if(last>MAX_CALC_MONTHS)return'<span class="no">قيمة غير صالحة</span>';const a=[];for(let i=Math.max(0,last-5);i<=last;i++){const e=new Date(s.y,s.m-1,s.d+30*i),full=s.tot>=(i+1)*r.fee-1e-6,part=!full&&s.tot>i*r.fee;a.push(`<span class="${full?"ok":part?"wa":"no"}">${esc(e.getDate())} ${MN[e.getMonth()]}${full?"✔":part?"◐":"✘"}</span>`)}return a.join(" ")}
window.alert=m=>{let e=$("#tt");if(!e){e=document.createElement("div");e.id="tt";e.style.cssText="position:fixed;bottom:16px;left:16px;right:16px;background:var(--tx);color:var(--bg);padding:10px;border-radius:8px;z-index:9;text-align:center";document.body.appendChild(e)}e.textContent=m;e.hidden=false;setTimeout(()=>e.hidden=true,2500)};

function nav(){$("#nav").innerHTML=TABS.map(t=>`<button class="${tab===t[0]?"on":""}" data-action="go" data-tab="${esc(t[0])}">${t[1]}${t[0]==="dash"&&soon().length?" <span class=\"bell\">🔔"+esc(soon().length)+"</span>":""}</button>`).join("")}
function go(t){tab=t;sel=null;cf=null;msg="";subFormOpen=false;subEdit=null;fx=1;render()}
function render(){
 hd();
 if(loadBlocked){
  $("#nav").innerHTML="";
  $("#app").className="";
  $("#app").innerHTML=loadErrorScreen();
  loadBackupList();
  return;
 }
 nav();
 $("#app").className=fx?"fx":"";
 fx=0;
 $("#app").innerHTML=({dash,stu,att,pay,tar,bc})[tab]();
 if(tab==="stu")sel?sub():flt();
 if(tab==="dash")cu();
}
function loadErrorScreen(){
 const canDesktop=IS_ELECTRON&&DESKTOP;
 return `<div class="card" style="border-color:var(--rd)"><h2 style="color:var(--rd)">${esc(loadErrorTitle)}</h2>
 <div>${esc(loadError)}</div>
 <div class="em">لم يتم تعديل ملف المعطيات الأصلي. الحفظ التلقائي موقوف لحماية البيانات.</div>
 <button class="b" data-action="retry-load">إعادة المحاولة</button>
 ${canDesktop?'<button class="s" data-action="open-folder">فتح مجلد البيانات</button>':""}
 ${canDesktop?'<button class="s" data-action="pick-file" data-target="imp2">استرجاع نسخة من ملف</button><input id="imp2" type="file" accept=".json" hidden data-action="import-file">':""}
 </div>
 ${canDesktop?'<div class="card"><h2>النسخ الاحتياطية</h2><div class="em">لا يتم استرجاع أي نسخة تلقائيا. النسخ غير الصالحة لا يمكن استرجاعها.</div><div id="bk-list" class="em">جار التحميل...</div></div>':""}`;
}
function retryLoad(){return startup().then(()=>render()).catch(showStartupError)}
function openFolder(){
 if(!DESKTOP||typeof DESKTOP.openDataFolder!=="function"){alert("تعذر فتح مجلد البيانات.");return}
 DESKTOP.openDataFolder().then(res=>{if(!res||!res.ok)alert((res&&res.error)||"تعذر فتح مجلد البيانات.")}).catch(()=>alert("تعذر فتح مجلد البيانات."));
}
function showBackups(){const box=document.getElementById("bk-list");if(box)box.textContent="جار التحميل...";loadBackupList()}
function loadBackupList(){
 const box=document.getElementById("bk-list");
 if(!box)return;
 if(!DESKTOP||typeof DESKTOP.listBackups!=="function"){box.textContent="تعذر قراءة النسخ الاحتياطية.";return}
 DESKTOP.listBackups().then(res=>{
  const el=document.getElementById("bk-list");
  if(!el)return;
  if(!res||!res.ok){el.textContent=(res&&res.error)||"تعذر قراءة النسخ الاحتياطية.";return}
  if(!res.backups.length){el.textContent="لا توجد نسخ احتياطية.";return}
  el.className="";
  el.innerHTML=`<div class="tw"><table><tr><th>الملف</th><th>الحالة</th><th></th></tr>${res.backups.map(b=>`<tr><td>${esc(b.name)}</td><td class="${b.valid?"ok":"no"}">${b.valid?"صالحة":"غير صالحة"}</td><td>${b.valid?`<button class="s" data-action="restore-backup" data-name="${esc(b.name)}">استرجاع</button>`:"-"}</td></tr>`).join("")}</table></div>`;
 }).catch(()=>{const el=document.getElementById("bk-list");if(el)el.textContent="تعذر قراءة النسخ الاحتياطية."});
}
async function restoreBk(name){
 if(restoring)return;
 if(!DESKTOP||typeof DESKTOP.restoreBackup!=="function"){alert("تعذر استرجاع النسخة الاحتياطية.");return}
 restoring=true;
 let res;
 try{res=await DESKTOP.restoreBackup(name)}catch(e){restoring=false;alert("تعذر استرجاع النسخة الاحتياطية.");return}
 restoring=false;
 if(!res||!res.ok){alert((res&&res.error)||"تعذر استرجاع النسخة الاحتياطية.");return}
 const ok=await reloadFromStore();
 if(!ok){alert("تم الاسترجاع لكن تعذر تحميل المعطيات. أعد المحاولة.");return}
 alert("تم استرجاع النسخة الاحتياطية");
}
async function restoreImported(clean){
 if(restoring)return;
 restoring=true;
 if(IS_ELECTRON){
  if(!DESKTOP||typeof DESKTOP.restoreImportedData!=="function"){restoring=false;alert("تعذر استيراد النسخة.");return}
  let res;
  try{res=await DESKTOP.restoreImportedData(JSON.stringify(clean))}catch(e){restoring=false;alert("تعذر استيراد النسخة.");return}
  restoring=false;
  if(!res||!res.ok){alert((res&&res.error)||"تعذر استيراد النسخة.");return}
  pendImp=null;
  const ok=await reloadFromStore();
  if(!ok){alert("تم الاستيراد لكن تعذر تحميل المعطيات. أعد المحاولة.");return}
  alert("تم الاستيراد");
  return;
 }
 D=clean;pendImp=null;loadBlocked=false;loadErrorTitle="";loadError="";
 if(!(await save())){restoring=false;render();return}
 restoring=false;render();alert("تم الاستيراد");
}

function dash(){
 const m=dM,act=D.regs.filter(r=>r.on);
 const inc=incomeForMonth(m);
 const due=act.filter(r=>stat(r).owed>0);
 const owed=due.reduce((a,r)=>a+stat(r).owed,0);
 return `<div class="card"><h2>🔔 أداءات قريبة (من 3 أيام أو أقل أو متأخرة)</h2>${soonT()}</div>
 <div class="card"><h2>إحصائيات الشهر (حسب تاريخ الأداء)</h2><label class="np" style="max-width:200px"><input type="month" value="${esc(m)}" data-action="dash-month"></label><br><div class="st">
 <div><b>${esc(D.students.length)}</b>تلميذ</div><div><b>${esc(act.length)}</b>تسجيل نشيط</div>
 <div><b class="ok">${esc(inc)}</b>درهم مقبوض</div><div><b class="no">${esc(owed)}</b>درهم باقي لحد اليوم</div></div></div>
 <div class="card"><h2>عليهم أداءات لحد اليوم</h2>${due.length?`<div class="tw"><table><tr><th>التلميذ</th><th>النشاط</th><th>الهاتف</th><th>الباقي</th><th></th></tr>${due.map(r=>{const s=D.students.find(x=>x.id===r.sid)||{};return `<tr><td>${esc(s.name)}</td><td>${esc(rLabel(r))}</td><td>${esc(s.phone)}</td><td class="no">${esc(stat(r).owed)}</td><td class="np">${wa(s,"السلام عليكم، تذكير من المركز: مازال باقي "+esc(stat(r).owed)+" درهم من أداء "+r.sub+" ديال "+s.name+". شكرا.")}</td></tr>`}).join("")}</table></div>`:'<div class="em">الكل مؤدي، أو لا توجد تسجيلات بعد.</div>'}</div>
 <div class="card"><h2>عدد التلاميذ فكل مادة ومستوى</h2>${byMat()}</div>
 <div class="card"><h2>غيابات متكررة (3 أو أكثر فآخر 30 يوم)</h2>${absAl()}</div>
 ${pendImp?`<div class="card np"><h2>تأكيد الاسترجاع</h2><div>الملف فيه ${esc(pendImp.students.length)} تلميذ و${esc(pendImp.pays.length)} أداء. غادي يعوض المعطيات الحالية (${esc(D.students.length)} تلميذ)، ونسخة منها كتتحفظ قبل.</div><button class="b" data-action="confirm-import">تأكيد الاسترجاع</button> <button class="s" data-action="cancel-import">إلغاء</button></div>`:""}
 <div class="card np"><h2>إعدادات المركز</h2><div class="g"><label>اسم المركز<input value="${esc(D.cfg.name)}" data-action="set-center-name"></label><label>الشعار (صورة)<input type="file" accept="image/*" data-action="set-logo"></label></div>${D.cfg.logo?`<button class="s" data-action="remove-logo">حذف الشعار</button>`:""}<div class="em">الشعار كيبان فالهيدر وفالوصل المطبوع.</div></div>
 <div class="card"><h2>نسخة احتياطية</h2><button class="s" data-action="export">تحميل نسخة</button> <button class="s" data-action="pick-file" data-target="imp">استرجاع نسخة</button>${IS_ELECTRON?' <button class="s" data-action="show-backups">النسخ الاحتياطية</button>':""}<input id="imp" type="file" accept=".json" hidden data-action="import-file"><div class="em">${IS_ELECTRON?"المعطيات كتتحفظ فـ Documents/CentreData/data.json، ونسخة احتياطية كتتحفظ قبل كل تعديل.":"المعطيات كتبقى فهاد المتصفح فقط، دير نسخة احتياطية من وقت لآخر."}</div><div id="bk-list" class="em"></div></div>`}
function exp(){const a=document.createElement("a");a.href="data:application/json;charset=utf-8,"+encodeURIComponent(JSON.stringify(D));a.download="centre-"+today()+".json";a.click()}
function imp(i){
 return new Promise(resolve=>{
  const f=i.files[0];if(!f){resolve();return}
  if(f.size>DV.MAX_JSON_BYTES){alert("الملف كبير جدا");i.value="";resolve();return}
  const r=new FileReader();
  r.onload=async()=>{
   i.value="";
   let text=String(r.result||"");
   if(text.charCodeAt(0)===0xfeff)text=text.slice(1);
   let x;
   try{x=JSON.parse(text)}catch(e){alert("ملف غير صالح: ليس JSON صالحا");resolve();return}
   const check=DV.validateData(x,{mode:"import"});
   if(!check.ok){alert("ملف غير صالح: "+check.error);resolve();return}
   if(loadBlocked){await restoreImported(check.data);resolve();return}
   pendImp=check.data;
   if(tab!=="dash"){tab="dash";sel=null;cf=null;msg="";}
   render();
   resolve();
  };
  r.onerror=()=>{i.value="";alert("تعذر قراءة الملف");resolve()};
  r.readAsText(f);
 })
}
function hd(){const c=D.cfg;$("#hd").innerHTML=`<div style="display:flex;align-items:center;gap:14px">${c.logo?`<img src="${esc(c.logo)}" alt="" style="height:52px;max-width:120px;object-fit:contain;background:#fff;border-radius:12px;padding:4px">`:'<span style="font-size:34px">🏫</span>'}<div><h1>${esc(c.name)}</h1><div style="opacity:.85;font-size:13px">دعم مدرسي · لغات · تكوين</div></div></div>`}
async function setN(v){D.cfg.name=v.trim()||"تسيير المركز";if(!(await persist()))return;render()}
async function rmLogo(){D.cfg.logo="";if(!(await persist()))return;render()}
function setLogo(i){
 return new Promise(resolve=>{
  const f=i.files[0];if(!f){resolve();return}
  if(!f.type||!f.type.startsWith("image/")||f.size>20*1024*1024){alert("صورة غير صالحة أو كبيرة");i.value="";resolve();return}
  const r=new FileReader();
  r.onload=()=>{
   const im=new Image();
   im.onload=async()=>{const s=Math.min(1,240/Math.max(im.width,im.height)),c=document.createElement("canvas");c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);c.getContext("2d").drawImage(im,0,0,c.width,c.height);D.cfg.logo=c.toDataURL("image/png");if(await persist())render();resolve()};
   im.onerror=()=>{alert("صورة غير صالحة");resolve()};
   im.src=r.result;
  };
  r.onerror=()=>{alert("تعذر قراءة الصورة");resolve()};
  r.readAsDataURL(f);i.value="";
 })
}
function okImp(){if(!pendImp||restoring)return;return restoreImported(pendImp)}

function stu(){
 if(sel){return detail()}
 return `<div class="card np"><h2>تلميذ جديد</h2><div class="g">
 <label>الاسم الكامل<input id="n"></label><label>هاتف ولي الأمر<input id="p" type="tel"></label>
 <label>المستوى<select id="l">${opts(LV)}</select></label><label>ملاحظات<input id="no"></label></div><button class="b" data-action="add-student">حفظ التلميذ</button></div>
 <div class="card"><h2>اللائحة (${esc(D.students.length)})</h2><input class="np" id="q" placeholder="بحث بالاسم أو الهاتف أو النشاط" data-action="filter-students">
 <div class="tw"><table id="tb"></table></div></div>`}
function flt(){const q=($("#q")||{value:""}).value.trim();const L=D.students.filter(s=>s.name.includes(q)||(s.phone||"").includes(q)||D.regs.some(r=>r.sid===s.id&&rLabel(r).includes(q)));
 $("#tb").innerHTML=L.length?`<tr><th>الاسم</th><th>الهاتف</th><th>التسجيلات</th><th></th></tr>`+L.map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.phone)}</td><td>${esc(D.regs.filter(r=>r.sid===s.id&&r.on).length)}</td><td><button class="s" data-action="open-student" data-id="${esc(s.id)}">فتح</button></td></tr>`).join(""):'<tr><td class="em">لا يوجد تلاميذ بعد.</td></tr>'}
async function addS(){const n=$("#n").value.trim();if(!n){alert("كتب الاسم");return}
 D.students.push({id:uid(),name:n,phone:$("#p").value.trim(),lvl:$("#l").value,note:$("#no").value.trim(),date:today()});if(!(await persist()))return;render()}
function detail(){
 const s=D.students.find(x=>x.id===sel);const R=D.regs.filter(r=>r.sid===sel);const RA=R.filter(r=>r.on);
 const P=D.pays.filter(p=>R.some(r=>r.id===p.rid)).sort((a,b)=>b.date.localeCompare(a.date));
 const A=[];for(const d in D.att)for(const rid in D.att[d])if(R.some(r=>r.id===rid))A.push([d,rid,D.att[d][rid]]);A.sort((a,b)=>b[0].localeCompare(a[0]));
 return `<button class="s np" data-action="back-to-students">رجوع</button>
 <div class="card"><h2>${esc(s.name)}</h2><div>الهاتف: ${esc(s.phone)||"-"} | المستوى: ${esc(s.lvl)} | مسجل منذ ${esc(s.date)}</div><div>ملاحظات: ${esc(s.note)||"-"}</div></div>
 <div class="card np"><h2>تعديل الملف</h2><div class="g"><label>الاسم<input id="en" value="${esc(s.name)}"></label><label>الهاتف<input id="ep" value="${esc(s.phone)}"></label><label>المستوى<select id="el">${optsSel(LV,s.lvl)}</select></label><label>ملاحظات<input id="eo" value="${esc(s.note)}"></label></div><button class="b" data-action="update-student">حفظ التعديل</button> <button class="s no" data-action="ask-delete-student">${cf==="ds"?"تأكيد حذف التلميذ وكل معطياته":"حذف التلميذ"}</button></div>
 <div class="card np"><h2>تسجيل في نشاط</h2><div class="g">
 <label>النشاط<select id="a" data-action="reg-activity">${opts(Object.keys(ACT))}</select></label>
 <label>المادة / اللغة / الدورة<select id="u" data-action="reg-subject"></select></label>
 <label>المستوى<select id="v">${opts(LV)}</select></label>
 <label>الثمن الشهري (درهم)<input id="f" type="number" min="0"></label><label>تاريخ البداية<input id="sd" type="date" value="${esc(today())}"></label></div>
 <button class="b" data-action="add-reg">تسجيل</button></div>
 ${msg}
 <div class="card np"><h2>أداء جديد</h2>${RA.length?`<div class="g"><label>التسجيل<select id="pr" data-action="detail-pay-reg">${RA.map(r=>`<option value="${esc(r.id)}">${esc(rLabel(r))}</option>`).join("")}</select></label><label>الشهر<input id="pm" type="month" value="${esc(month())}"></label><label>عدد الأشهر<input id="pk" type="number" min="1" value="1" data-action="detail-pay-months"></label><label>تاريخ الأداء<input id="pd" type="date" value="${esc(today())}"></label><label>المبلغ (درهم)<input id="pa" type="number" min="1" value="${esc(RA[0].fee||"")}"></label></div><button class="b" data-action="add-detail-payment">تسجيل الأداء وإخراج الوصل</button>`:'<div class="em">سجل التلميذ فنشاط أولا.</div>'}</div>
 <div class="card"><h2>التسجيلات</h2>${R.length?`<div class="tw"><table><tr><th>النشاط</th><th>البداية</th><th>الثمن</th><th>ينتهي الأداء</th><th>الخلاص</th><th>الحالة</th><th></th></tr>${R.map(r=>`<tr><td>${esc(rLabel(r))}</td><td><input type="date" value="${esc(r.date)}" data-action="reg-date" data-id="${esc(r.id)}"></td><td><input type="number" min="0" value="${esc(r.fee)}" style="width:80px" data-action="reg-fee" data-id="${esc(r.id)}"></td><td>${endD(r)}</td><td>${mst(r)}</td><td class="${r.on?"ok":"no"}">${r.on?"نشيط":"متوقف"}</td><td class="np"><button class="s" data-action="toggle-reg" data-id="${esc(r.id)}">${r.on?"إيقاف":"تفعيل"}</button></td></tr>`).join("")}</table></div>`:'<div class="em">لا يوجد تسجيل.</div>'}</div>
 <div class="card"><h2>تاريخ الأداءات</h2>${P.length?`<div class="tw"><table><tr><th>التاريخ</th><th>الشهر</th><th>النشاط</th><th>المبلغ</th><th></th></tr>${P.map(p=>`<tr><td>${esc(p.date)}</td><td>${esc(p.month)}${(p.n||1)>1?" ("+esc(p.n)+" أشهر)":""}</td><td>${esc(rLabel(D.regs.find(r=>r.id===p.rid)))}</td><td>${esc(p.amt)}</td><td class="np"><button class="s" data-action="receipt" data-id="${esc(p.id)}">وصل</button> ${dp(p.id)}</td></tr>`).join("")}</table></div>`:'<div class="em">لا توجد أداءات.</div>'}</div>
 <div class="card"><h2>تاريخ الحضور</h2>${A.length?`<div class="tw"><table><tr><th>التاريخ</th><th>النشاط</th><th>الحالة</th></tr>${A.slice(0,40).map(a=>`<tr><td>${esc(a[0])}</td><td>${esc(rLabel(D.regs.find(r=>r.id===a[1])))}</td><td class="${a[2]?"ok":"no"}">${a[2]?"حاضر":"غائب"}</td></tr>`).join("")}</table></div>`:'<div class="em">لا يوجد تسجيل حضور.</div>'}</div>`}
function dynamicSubjects(){return Array.isArray(D.subjects)?D.subjects:[]}
function subjectsFor(a){const base=ACT[a]||[];const extra=dynamicSubjects().filter(s=>s.act===a&&!base.includes(s.name)).map(s=>s.name);return base.concat(extra)}
function subjectPrice(s){return D.prices[s.act+"|"+s.name]}
function sub(){const a=$("#a");if(a){$("#u").innerHTML=optsVals(subjectsFor(a.value));fillF()}}
function subjectNameMax(act){return act?DV.maxSubjectNameLength(act):DV.MAX_PRICE_KEY_LENGTH}
function syncSubjectMax(act){
 const input=$("#sn");
 if(!input)return;
 const max=subjectNameMax(act);
 input.maxLength=max;
 if(typeof input.setAttribute==="function")input.setAttribute("maxlength",String(max));
}
function fillF(){const p=D.prices[$("#a").value+"|"+$("#u").value];$("#f").value=p===undefined?"":p}
function subjectForm(){
 const s=subEdit?dynamicSubjects().find(x=>x.id===subEdit):null;
 const price=s?subjectPrice(s):"";
 const max=subjectNameMax(s?s.act:"");
 return `<div class="card"><h2>${s?"تعديل مادة مضافة":"إضافة مادة جديدة"}</h2><div class="em">المواد المضافة كتبان مباشرة فنموذج تسجيل التلاميذ. المواد الأساسية ثابتة وما كتتبدلش.</div><div class="g"><label>النشاط${s?`<div style="padding:10px 12px;border:1px solid var(--bd);border-radius:12px;background:var(--bg)">${esc(s.act)}</div>`:`<select id="sa" data-action="subject-activity"><option value="">اختر النشاط</option>${Object.keys(ACT).map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select>`}</label><label>اسم المادة<input id="sn" maxlength="${max}" value="${esc(s?s.name:"")}"></label><label>الثمن الشهري (درهم)<input id="sp" type="number" min="0" placeholder="درهم" value="${esc(price===undefined?"":price)}"></label></div>${s?`<button class="b" data-action="save-subject">حفظ التعديل</button>`:`<button class="b" data-action="add-subject">إضافة المادة</button>`} <button class="s" data-action="cancel-subject-form">إلغاء</button></div>`
}
function tar(){
 const list=dynamicSubjects();
 const pending=list.find(s=>cf==="sub"+s.id);
 return `${subjectAdmin(list,pending)}<div class="card"><h2>التعريفة الشهرية للمواد الأساسية</h2><div class="em">المواد الأساسية ثابتة وما يمكنش تحذفها أو تبدل اسمها. الثمن اللي كتكتب هنا كيتعمر أوتوماتيكيا ملي كتسجل تلميذ، وتقدر تبدلو عند التسجيل. التسجيلات القديمة كتبقى بثمنها.</div>${Object.keys(ACT).map(a=>`<h2>${esc(a)}</h2><div class="g">${ACT[a].map(u=>`<label>${esc(u)} <span class="em">(${esc(cnt(a+"|"+u))} تلميذ)</span><input type="number" min="0" placeholder="درهم" data-action="set-price" data-key="${esc(a+"|"+u)}" value="${esc(D.prices[a+"|"+u]??"")}"></label>`).join("")}</div>`).join("")}</div>`
}
function subjectAdmin(list,pending){
 return `<div class="card"><h2>المواد المضافة</h2><div class="em">المواد اللي كتزيدها هنا كتبان مباشرة فاختيار المادة عند تسجيل التلميذ. يمكن تعديلها أو حذفها، وحذفها ما كيمسش بالتسجيلات القديمة.</div><button class="b" data-action="toggle-subject-form">${subFormOpen||subEdit?"إغلاق النموذج":"+ إضافة مادة"}</button>${subFormOpen||subEdit?subjectForm():""}${list.length?`<div class="tw"><table><tr><th>النشاط</th><th>المادة</th><th>الثمن الشهري</th><th></th></tr>${list.map(s=>`<tr><td>${esc(s.act)}</td><td>${esc(s.name)}</td><td>${esc(subjectPrice(s)??"")}</td><td class="np"><button class="s" data-action="edit-subject" data-id="${esc(s.id)}">تعديل</button> <button class="s no" data-action="ask-delete-subject" data-id="${esc(s.id)}">${cf==="sub"+s.id?"تأكيد الحذف":"حذف"}</button></td></tr>`).join("")}</table></div>`:'<div class="em">لا توجد مواد مضافة بعد.</div>'}${pending?`<div class="em" style="color:var(--rd)">غادي تتحذف المادة "${esc(pending.name)}" من لائحة المواد فقط. التسجيلات والأداءات والحضور القديمة ما غاديش يتبدلو.</div>`:""}</div>`
}
async function setP(k,v){if(v===""){delete D.prices[k];await persist();return}const n=parseFloat(v);if(!validFee(n)){alert("الثمن غير صالح");return}D.prices[k]=n;await persist()}
async function addSubject(){
 const act=$("#sa")?$("#sa").value:"",name=DV.normalizeSubjectName($("#sn")?$("#sn").value:""),price=$("#sp")?parseFloat($("#sp").value):NaN;
 if(!Object.prototype.hasOwnProperty.call(ACT,act)){alert("اختار النشاط");return}
 if(!name){alert("كتب اسم المادة");return}
 if(name.length>subjectNameMax(act)){alert("اسم المادة طويل جدا. الحد الأقصى فهاد النشاط هو "+subjectNameMax(act)+" حرفا");return}
 if(name.includes("|")){alert("اسم المادة غير صالح");return}
 if((ACT[act]||[]).includes(name)||dynamicSubjects().some(s=>s.act===act&&DV.normalizeSubjectName(s.name)===name)){alert("هاد المادة كاينة فهاد النشاط");return}
 if(!validFee(price)){alert("الثمن غير صالح");return}
 D.subjects=dynamicSubjects().concat([{id:uid(),act:act,name:name}]);
 D.prices[act+"|"+name]=price;
 if(!(await persist()))return;
 subFormOpen=false;subEdit=null;render();
}
async function saveSubject(){
 const s=dynamicSubjects().find(x=>x.id===subEdit);
 if(!s){subFormOpen=false;subEdit=null;render();return}
 const name=DV.normalizeSubjectName($("#sn")?$("#sn").value:""),price=$("#sp")?parseFloat($("#sp").value):NaN;
 if(!name){alert("كتب اسم المادة");return}
 if(name.length>subjectNameMax(s.act)){alert("اسم المادة طويل جدا. الحد الأقصى فهاد النشاط هو "+subjectNameMax(s.act)+" حرفا");return}
 if(name.includes("|")){alert("اسم المادة غير صالح");return}
 if(name!==s.name&&((ACT[s.act]||[]).includes(name)||dynamicSubjects().some(x=>x.id!==s.id&&x.act===s.act&&DV.normalizeSubjectName(x.name)===name))){alert("هاد المادة كاينة فهاد النشاط");return}
 if(!validFee(price)){alert("الثمن غير صالح");return}
 const oldKey=s.act+"|"+s.name,newKey=s.act+"|"+name;
 if(oldKey!==newKey)delete D.prices[oldKey];
 D.prices[newKey]=price;s.name=name;
 if(!(await persist()))return;
 subFormOpen=false;subEdit=null;render();
}
async function delSubject(id){
 const s=dynamicSubjects().find(x=>x.id===id);if(!s)return;
 D.subjects=dynamicSubjects().filter(x=>x.id!==id);
 delete D.prices[s.act+"|"+s.name];
 cf=null;subFormOpen=false;if(subEdit===id)subEdit=null;
 if(!(await persist()))return;
 render();
}
async function addR(){const f=parseFloat($("#f").value);if(!Number.isFinite(f)||f<0){alert("كتب الثمن");return}
 if(f>MAX_MONEY){alert("الثمن كبير جدا");return}
 if(D.regs.some(r=>r.sid===sel&&r.on&&r.act===$("#a").value&&r.sub===$("#u").value)){alert("هاد التلميذ مسجل ونشيط فهاد المادة");return}
 D.regs.push({id:uid(),sid:sel,act:$("#a").value,sub:$("#u").value,lvl:$("#v").value,fee:f,on:true,date:$("#sd").value||today()});if(!(await persist()))return;render()}
async function tg(id){const r=D.regs.find(x=>x.id===id);if(!r)return;if(!r.on&&D.regs.some(x=>x.id!==r.id&&x.sid===r.sid&&x.on&&x.act===r.act&&x.sub===r.sub)){alert("كاين تسجيل نشيط آخر فنفس المادة");return}r.on=!r.on;if(!(await persist()))return;render()}
async function sF(id,v){const r=D.regs.find(x=>x.id===id);if(!r)return;const f=parseFloat(v);if(!validFee(f)){alert("الثمن غير صالح");return}r.fee=f;if(!(await persist()))return;render()}
async function sD(id,v){const r=D.regs.find(x=>x.id===id);if(!r||!v)return;r.date=v;if(!(await persist()))return;render()}
async function upS(){const s=D.students.find(x=>x.id===sel),n=$("#en").value.trim();if(!n){alert("كتب الاسم");return}Object.assign(s,{name:n,phone:$("#ep").value.trim(),lvl:$("#el").value,note:$("#eo").value.trim()});if(await persist()){render();alert("تم الحفظ")}}
async function delS(){const ids=D.regs.filter(r=>r.sid===sel).map(r=>r.id);D.regs=D.regs.filter(r=>r.sid!==sel);D.pays=D.pays.filter(p=>!ids.includes(p.rid));for(const d in D.att)for(const i of ids)delete D.att[d][i];D.students=D.students.filter(s=>s.id!==sel);cf=null;if(!(await persist()))return;go("stu")}
function fillP(){const r=D.regs.find(x=>x.id===$("#r").value);$("#a").value=paymentAmount(r,paymentMonths($("#k").value))}
function fillA(){const r=D.regs.find(x=>x.id===$("#pr").value);$("#pa").value=paymentAmount(r,paymentMonths($("#pk").value))}
async function addPS(){const a=parseFloat($("#pa").value),r=$("#pr").value,n=paymentMonths($("#pk").value),date=paymentDate();if(!r||!Number.isFinite(a)||a<=0){alert("اختار التسجيل وكتب المبلغ");return}if(a>MAX_MONEY){alert("المبلغ كبير جدا");return}if(n===null){alert("عدد الأشهر غير صالح");return}if(date===null){alert("تاريخ الأداء غير صالح");return}const p={id:uid(),rid:r,month:$("#pm").value,n:n,amt:a,date:date};D.pays.push(p);if(!(await persist()))return;rc(p.id,1)}
async function delP(id){D.pays=D.pays.filter(p=>p.id!==id);cf=null;msg="";if(!(await persist()))return;render()}
const fd=e=>String(e.getDate()).padStart(2,"0")+"/"+String(e.getMonth()+1).padStart(2,"0")+"/"+e.getFullYear();
function wa(s,txt){let p=(s.phone||"").replace(/\D/g,"");if(!p)return'<span class="em">بلا هاتف</span>';if(p.startsWith("00"))p=p.slice(2);else if(p.startsWith("0"))p="212"+p.slice(1);else if(p.length===9)p="212"+p;return`<a class="s" style="text-decoration:none;display:inline-block" target="_blank" rel="noopener" href="https://wa.me/${esc(p)}?text=${encodeURIComponent(txt)}">واتساب</a>`}
function soon(){const[ty,tm,td]=today().split("-").map(Number),t=new Date(ty,tm-1,td),out=[];for(const r of D.regs.filter(r=>r.on&&Number.isFinite(r.fee)&&r.fee>0)){const tot=D.pays.filter(p=>p.rid===r.id).reduce((a,p)=>a+p.amt,0),k=Math.floor(tot/r.fee+1e-9);if(!Number.isFinite(k)||!Number.isSafeInteger(k)||k<0||k>MAX_CALC_MONTHS)continue;const[y,mo,d]=r.date.split("-").map(Number),n=Math.round((new Date(y,mo-1,d+30*k)-t)/864e5);if(n<=3)out.push({r,n,part:Math.round(tot-k*r.fee),due:fd(new Date(y,mo-1,d+30*k)),rest:Math.round((k+1)*r.fee-tot)})}return out.sort((a,b)=>a.n-b.n)}
function soonT(){const L=soon();return L.length?`<div class="tw"><table><tr><th>التلميذ</th><th>النشاط</th><th>الهاتف</th><th>الموعد</th><th>المؤدى</th><th>الباقي</th><th></th></tr>${L.map(({r,n,part,rest,due})=>{const s=D.students.find(x=>x.id===r.sid)||{};return `<tr><td>${esc(s.name)}</td><td>${esc(rLabel(r))}</td><td>${esc(s.phone)}</td><td class="${n<0?"no":"wa"}">${n<0?"متأخر "+esc(-n)+" يوم":n===0?"اليوم":"بعد "+esc(n)+" يوم"}</td><td>${esc(part)}</td><td class="no">${esc(rest)}</td><td class="np">${wa(s,"السلام عليكم، تذكير من المركز: أداء "+r.sub+" ديال "+s.name+(n<0?" فات موعدو ":" موعدو ")+esc(due)+". الباقي: "+esc(rest)+" درهم. شكرا.")}</td></tr>`}).join("")}</table></div>`:'<div class="em">لا يوجد أداء قريب. كل شهر مؤدى كيغطي 30 يوم ابتداء من تاريخ بداية التسجيل.</div>'}
let bT="",bF="";
const TPL=["السلام عليكم، نعلمكم أن الأستاذ(ة) غائب اليوم، والحصة ديال {الاسم} ما غاديش تكون. نعتذرو على الإزعاج.","السلام عليكم، نعلمكم أن المركز غادي يكون مسدود [التاريخ]. نعتذرو على الإزعاج.","السلام عليكم، نعلمكم أن المركز غادي يتحل [التاريخ] وغادي نستأنفو الحصص بشكل عادي. شكرا."],TN=["الأستاذ غائب","المركز مسدود","المركز غادي يتحل"];
function setT(i){bT=TPL[i];render()}
function waM(s,t){return wa(s,t).replace("<a ","<a data-action=\"mark-sent\" ")}
function bc(){const ks=[...new Set(D.regs.filter(r=>r.on).map(r=>r.act+"|"+r.sub))],L=[...new Set(D.regs.filter(r=>r.on&&(!bF||r.act+"|"+r.sub===bF)).map(r=>r.sid))].map(i=>D.students.find(s=>s.id===i)).filter(Boolean);
 return `<div class="card"><h2>رسالة لأولياء الأمور</h2><div>${TN.map((t,i)=>`<button class="s" data-action="set-template" data-index="${esc(i)}">${t}</button>`).join(" ")}</div><br><label>الرسالة (كتب {الاسم} باش يتعوض باسم التلميذ)<textarea rows="4" data-action="message-text" style="width:100%;padding:8px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--tx);font:inherit">${esc(bT)}</textarea></label><br><br><label>المرسل إليهم<select data-action="message-filter"><option value="">كل التلاميذ</option>${ks.map(k=>`<option value="${esc(k)}" ${k===bF?"selected":""}>${esc(k.replace("|"," – "))} (${esc(cnt(k))})</option>`).join("")}</select></label></div>
 <div class="card"><h2>اللائحة (${esc(L.length)})</h2><div class="em">واتساب كيتفتح لكل ولي بالرسالة جاهزة، وكتضغط إرسال. ما كاينش إرسال جماعي أوتوماتيكي.</div>${L.length?`<div class="tw"><table><tr><th>التلميذ</th><th>الهاتف</th><th></th></tr>${L.map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.phone)}</td><td>${bT.trim()?waM(s,bT.replace(/\{الاسم\}/g,s.name)):"-"}</td></tr>`).join("")}</table></div>`:'<div class="em">لا يوجد تلاميذ.</div>'}</div>`}
function cnt(k){return new Set(D.regs.filter(r=>r.on&&r.act+"|"+r.sub===k).map(r=>r.sid)).size}
function byMat(){const m={};for(const r of D.regs.filter(r=>r.on)){const k=r.act+"|"+r.sub+"|"+r.lvl;(m[k]=m[k]||new Set()).add(r.sid)}const ks=Object.keys(m).sort((a,b)=>{const x=a.split("|"),y=b.split("|");return (x[0]+x[1]).localeCompare(y[0]+y[1])||LV.indexOf(x[2])-LV.indexOf(y[2])});return ks.length?`<div class="tw"><table><tr><th>النشاط</th><th>المادة</th><th>المستوى</th><th>عدد التلاميذ</th></tr>${ks.map(k=>{const[a,u,l]=k.split("|");return `<tr><td>${esc(a)}</td><td>${esc(u)}</td><td>${esc(l)}</td><td><b>${esc(m[k].size)}</b></td></tr>`}).join("")}</table></div>`:'<div class="em">لا توجد تسجيلات بعد.</div>'}
function absAl(){const lim=DV.localDate(new Date(Date.now()-2592e6)),c={};for(const d in D.att)if(d>=lim)for(const i in D.att[d])if(D.att[d][i]===false)c[i]=(c[i]||0)+1;const L=D.regs.filter(r=>c[r.id]>=3);return L.length?`<div class="tw"><table><tr><th>التلميذ</th><th>النشاط</th><th>الغيابات</th></tr>${L.map(r=>`<tr><td>${esc(sName(r.sid))}</td><td>${esc(rLabel(r))}</td><td class="no">${esc(c[r.id])}</td></tr>`).join("")}</table></div>`:'<div class="em">لا توجد.</div>'}

let aD=today(),aF="";
function att(){
 const R=D.regs.filter(r=>r.on&&(!aF||r.act+"|"+r.sub===aF));
 const ks=[...new Set(D.regs.filter(r=>r.on).map(r=>r.act+"|"+r.sub))];
 const cur=D.att[aD]||{};
 return `<div class="card np"><div class="g"><label>التاريخ<input type="date" value="${esc(aD)}" data-action="attendance-date"></label>
 <label>التصفية<select data-action="attendance-filter"><option value="">الكل</option>${ks.map(k=>`<option value="${esc(k)}" ${k===aF?"selected":""}>${esc(k.replace("|"," – "))} (${esc(cnt(k))})</option>`).join("")}</select></label></div></div>
 <div class="card"><h2>الحضور ${esc(aD)}</h2>${R.length?`<div class="tw"><table><tr><th>التلميذ</th><th>النشاط</th><th>الحالة</th></tr>${R.map(r=>`<tr><td>${esc(sName(r.sid))}</td><td>${esc(rLabel(r))}</td><td><button class="s ${cur[r.id]===false?"no":""}" data-action="toggle-attendance" data-id="${esc(r.id)}">${cur[r.id]===undefined?"لم يسجل":cur[r.id]?"✔ حاضر":"✘ غائب"}</button></td></tr>`).join("")}</table></div>`:'<div class="em">لا توجد تسجيلات نشيطة.</div>'}</div>`}
async function mk(id){D.att[aD]=D.att[aD]||{};const c=D.att[aD][id];D.att[aD][id]=c===undefined?true:c?false:undefined;if(D.att[aD][id]===undefined)delete D.att[aD][id];if(!(await persist()))return;render()}

function pay(){
 const R=D.regs.filter(r=>r.on);
 const L=D.pays.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30);
 return `<div class="card np"><h2>أداء جديد</h2><div class="g">
 <label>التسجيل<select id="r" data-action="pay-reg">${R.map(r=>`<option value="${esc(r.id)}">${esc(sName(r.sid))} – ${esc(rLabel(r))}</option>`).join("")}</select></label>
 <label>الشهر<input id="m" type="month" value="${esc(month())}"></label>
 <label>عدد الأشهر<input id="k" type="number" min="1" value="1" data-action="pay-months"></label><label>تاريخ الأداء<input id="pd" type="date" value="${esc(today())}"></label><label>المبلغ الإجمالي (درهم)<input id="a" type="number" min="1" value="${esc(R.length?R[0].fee||"":"")}"></label></div>
 <button class="b" data-action="add-payment">تسجيل الأداء وإخراج الوصل</button></div>
 ${msg}
 <div class="card"><h2>آخر الأداءات</h2>${L.length?`<div class="tw"><table><tr><th>التاريخ</th><th>التلميذ</th><th>النشاط</th><th>الشهر</th><th>المبلغ</th><th></th></tr>${L.map(p=>{const r=D.regs.find(x=>x.id===p.rid);return `<tr><td>${esc(p.date)}</td><td>${esc(sName(r.sid))}</td><td>${esc(rLabel(r))}</td><td>${esc(p.month)}</td><td>${esc(p.amt)}</td><td class="np"><button class="s" data-action="receipt" data-id="${esc(p.id)}">وصل</button> ${dp(p.id)}</td></tr>`}).join("")}</table></div>`:'<div class="em">لا توجد أداءات بعد.</div>'}</div>`}
async function addP(){const a=parseFloat($("#a").value),r=$("#r").value,n=paymentMonths($("#k").value),date=paymentDate();if(!r||!Number.isFinite(a)||a<=0){alert("اختار التسجيل وكتب المبلغ");return}
 if(a>MAX_MONEY){alert("المبلغ كبير جدا");return}
 if(n===null){alert("عدد الأشهر غير صالح");return}
 if(date===null){alert("تاريخ الأداء غير صالح");return}
 const p={id:uid(),rid:r,month:$("#m").value,n:n,amt:a,date:date};D.pays.push(p);if(!(await persist()))return;rc(p.id)}
function rc(id,stay){const p=D.pays.find(x=>x.id===id);if(!p)return;const r=D.regs.find(x=>x.id===p.rid);if(!r)return;const f=stat(r).owed;
 const n=D.pays.indexOf(p)+1;
 msg=`<div class="card" id="rcp">${D.cfg.logo?`<img src="${esc(D.cfg.logo)}" alt="" style="height:56px;margin-bottom:6px">`:""}<div><b>${esc(D.cfg.name)}</b></div><h2>وصل رقم ${esc(String(n).padStart(4,"0"))}</h2>
 <div>التاريخ: ${esc(p.date)}</div><div>التلميذ: ${esc(sName(r.sid))}</div><div>النشاط: ${esc(rLabel(r))}</div>
 <div>الشهر: ${esc(p.month)}${(p.n||1)>1?" إلى "+esc(mAdd(p.month,p.n-1)):""}</div><div><b>المبلغ المؤدى: ${esc(p.amt)} درهم</b></div>
 <div class="${f>0?"wa":"ok"}">${f>0?"الباقي: "+esc(f)+" درهم":"مؤدى حتى "+endD(r)}</div>
 <button class="b np" data-action="print">طباعة</button> <button class="s np" data-action="close-receipt">إغلاق</button></div>`;
 if(!stay)tab="pay";render();window.scrollTo(0,0)}
const ACTIONS={
 "go":el=>go(el.getAttribute("data-tab")),
 "retry-load":()=>retryLoad(),
 "open-folder":()=>openFolder(),
 "pick-file":el=>{const t=document.getElementById(el.getAttribute("data-target"));if(t)t.click()},
 "import-file":el=>imp(el),
 "restore-backup":el=>restoreBk(el.getAttribute("data-name")),
 "dash-month":el=>{dM=el.value||month();render()},
 "confirm-import":()=>okImp(),
 "cancel-import":()=>{pendImp=null;render()},
 "set-center-name":el=>setN(el.value),
 "set-logo":el=>setLogo(el),
 "remove-logo":()=>rmLogo(),
 "export":()=>exp(),
 "show-backups":()=>showBackups(),
 "add-student":()=>addS(),
 "filter-students":()=>flt(),
 "open-student":el=>{msg="";sel=el.getAttribute("data-id");render()},
 "back-to-students":()=>go("stu"),
 "update-student":()=>upS(),
 "ask-delete-student":()=>{if(cf==="ds"){cf=null;delS()}else{cf="ds";render()}},
 "ask-delete-payment":el=>{const id=el.getAttribute("data-id"),key="p"+id;if(cf===key){cf=null;delP(id)}else{cf=key;render()}},
 "add-reg":()=>addR(),
 "reg-activity":()=>sub(),
 "reg-subject":()=>fillF(),
 "add-detail-payment":()=>addPS(),
 "detail-pay-reg":()=>fillA(),
 "detail-pay-months":()=>fillA(),
 "reg-date":el=>sD(el.getAttribute("data-id"),el.value),
 "reg-fee":el=>sF(el.getAttribute("data-id"),el.value),
 "toggle-reg":el=>tg(el.getAttribute("data-id")),
 "receipt":el=>rc(el.getAttribute("data-id")),
 "set-price":el=>setP(el.getAttribute("data-key"),el.value),
 "toggle-subject-form":()=>{if(subEdit){subEdit=null;subFormOpen=true}else{subFormOpen=!subFormOpen}render()},
 "subject-activity":el=>syncSubjectMax(el&&el.value),
 "cancel-subject-form":()=>{subFormOpen=false;subEdit=null;render()},
 "add-subject":()=>addSubject(),
 "save-subject":()=>saveSubject(),
 "edit-subject":el=>{subEdit=el.getAttribute("data-id");subFormOpen=false;render()},
 "ask-delete-subject":el=>{const id=el.getAttribute("data-id"),key="sub"+id;if(cf===key){cf=null;delSubject(id)}else{cf=key;render()}},
 "set-template":el=>setT(Number(el.getAttribute("data-index"))),
 "message-text":el=>{bT=el.value},
 "message-filter":el=>{bF=el.value;render()},
 "attendance-date":el=>{aD=el.value;render()},
 "attendance-filter":el=>{aF=el.value;render()},
 "toggle-attendance":el=>mk(el.getAttribute("data-id")),
 "pay-reg":()=>fillP(),
 "pay-months":()=>fillP(),
 "add-payment":()=>addP(),
 "print":()=>window.print(),
 "close-receipt":()=>{msg="";render()},
 "mark-sent":el=>{el.textContent="✔ تم"},
};
const ACTION_EVENTS={
 "import-file":"change",
 "dash-month":"change",
 "set-center-name":"change",
 "set-logo":"change",
 "reg-activity":"change",
 "reg-subject":"change",
 "subject-activity":"change",
 "detail-pay-reg":"change",
 "detail-pay-months":"input",
 "reg-date":"change",
 "reg-fee":"change",
 "set-price":"change",
 "message-text":"input",
 "message-filter":"change",
 "attendance-date":"change",
 "attendance-filter":"change",
 "pay-reg":"change",
 "pay-months":"input",
 "filter-students":"input",
};
function closestAction(node){
 while(node&&node!==document){
  if(node.getAttribute&&node.getAttribute("data-action"))return node;
  node=node.parentNode;
 }
 return null;
}
function handleActionEvent(event){
 if(shuttingDown)return;
 const el=closestAction(event.target);
 if(!el)return;
 const action=el.getAttribute("data-action");
 if((ACTION_EVENTS[action]||"click")!==event.type)return;
 const fn=ACTIONS[action];
 if(typeof fn==="function")trackAction(fn(el));
}
function bindEvents(){
 document.addEventListener("click",handleActionEvent);
 document.addEventListener("change",handleActionEvent);
 document.addEventListener("input",handleActionEvent);
}
bindEvents();
if(DESKTOP&&typeof DESKTOP.onClosing==="function"){
 DESKTOP.onClosing(closeForShutdown);
}
startup().then(()=>render()).catch(showStartupError);
