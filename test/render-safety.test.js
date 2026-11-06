const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const DV = require("../data-validation");

class Element {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.value = "";
    this.files = [];
    this.style = {};
  }
  remove() {}
  click() {}
}

function loadApp(options) {
  const opts = options || {};
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.ok(source.length > 0, "app script not found");

  const listeners = Object.create(null);
  const elements = Object.create(null);
  for (const id of ["hd", "nav", "app", "q", "tb", "bk-list", "imp", "imp2", "en", "ep", "el", "eo", "n", "p", "l", "no", "a", "u", "v", "f", "sd", "pa", "pr", "pm", "pk", "pd", "r", "m", "k", "sa", "sn", "sp"]) {
    elements[id] = new Element(id);
  }
  elements.a.value = "دعم مدرسي";
  elements.pd.value = DV.localDate(new Date());
  const document = {
    querySelector(selector) {
      return selector.startsWith("#") ? elements[selector.slice(1)] || null : null;
    },
    getElementById(id) {
      return elements[id] || null;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return new Element("");
    },
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    body: { appendChild() {} },
  };
  const alerts = [];
  const storage = opts.localStorage || { getItem() { return null; }, setItem() {} };
  const context = {
    window: { DataValidation: DV, desktop: opts.desktop, scrollTo() {} },
    document,
    navigator: { userAgent: opts.userAgent || "node" },
    localStorage: storage,
    alert(message) { alerts.push(String(message)); },
    console,
    performance: { now() { return 0; } },
    requestAnimationFrame() {},
    setTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app.js" });
  return {
    context,
    elements,
    alerts,
    listeners,
    run(expression) { return vm.runInContext(expression, context); },
    settle() { return new Promise((resolve) => setTimeout(resolve, 0)); },
  };
}

const malicious = "<img src=x onerror=alert(1)>";

test("all tabs render hostile imported text without creating executable markup", () => {
  const app = loadApp();
  app.run(`
    D.cfg.name=${JSON.stringify(malicious)};
    D.cfg.logo='x" onerror="alert(1)';
    D.students=[{id:"s1",name:${JSON.stringify(malicious)},phone:'"><img src=x onerror=alert(2)>',lvl:${JSON.stringify(malicious)},note:${JSON.stringify(malicious)},date:"2026-01-01"}];
    D.regs=[{id:"r1",sid:"s1",act:${JSON.stringify(malicious)},sub:${JSON.stringify(malicious)},lvl:${JSON.stringify(malicious)},fee:200,on:true,date:"2026-01-01"}];
    D.pays=[{id:"p1",rid:"r1",month:"2026-01",n:1,amt:200,date:"2026-01-02"}];
    D.att={"2026-01-02":{r1:false}};
    D.prices={};
    D.subjects=[{id:"sub1",act:"دعم مدرسي",name:${JSON.stringify(malicious)}}];
  `);

  for (const tab of ["dash", "stu", "att", "pay", "tar", "bc"]) {
    app.run(`tab=${JSON.stringify(tab)};sel=null;render();`);
    const output = app.elements.app.innerHTML + app.elements.hd.innerHTML + app.elements.nav.innerHTML + app.elements.tb.innerHTML;
    assert.equal(output.includes("<img src=x"), false, tab);
    assert.equal(output.includes('" onerror="'), false, tab);
  }

  app.run('tab="stu";sel="s1";render();');
  const detail = app.elements.app.innerHTML + app.elements.hd.innerHTML;
  assert.equal(detail.includes("<img src=x"), false);
  assert.equal(detail.includes('" onerror="'), false);
});

test("load failure shows an Arabic error screen without rendering data", () => {
  const app = loadApp();
  app.run('blockLoad("تعذر تحميل المعطيات","ملف data.json غير صالح");');
  const output = app.elements.app.innerHTML;
  assert.match(output, /تعذر تحميل المعطيات/);
  assert.match(output, /لم يتم تعديل ملف المعطيات الأصلي/);
  assert.match(output, /الحفظ التلقائي موقوف/);
});

function prepareStudent(app) {
  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"قديم",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    sel="s1";tab="stu";
  `);
  app.elements.en.value = "جديد";
  app.elements.ep.value = "0612345678";
  app.elements.el.value = "";
  app.elements.eo.value = "";
}

test("a refused save shows the Arabic reason and never reports success", async () => {
  const message = "ملف المعطيات الحالي غير صالح (JSON). لم يتم تعديل الملف وتم إيقاف الحفظ.";
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: async () => ({ ok: false, code: "INVALID_JSON", error: message }),
    },
  });
  await app.settle();
  prepareStudent(app);

  await app.run("upS()");

  assert.equal(app.run("saveError"), message);
  assert.equal(app.alerts.some((item) => item.includes("تم الحفظ")), false);
});

test("each refused save code shows its Arabic message", async () => {
  const cases = [
    ["INVALID_JSON", "ملف المعطيات الحالي غير صالح (JSON). لم يتم تعديل الملف وتم إيقاف الحفظ."],
    ["INVALID_DATA", "بيانات غير صالحة. لم يتم تعديل الملف وتم إيقاف الحفظ."],
    ["LOCKED", "الحفظ موقوف لحماية البيانات. أصلح الملف الأصلي أو استرجع نسخة موثوقة."],
  ];

  for (const [code, message] of cases) {
    const app = loadApp({
      userAgent: "Electron/33",
      desktop: {
        load: async () => ({ ok: true, firstRun: true }),
        save: async () => ({ ok: false, code: code, error: message }),
      },
    });
    await app.settle();
    const saved = await app.run("save()");
    assert.equal(saved, false, code);
    assert.equal(app.run("saveError"), message, code);
    assert.equal(app.alerts.some((item) => item.includes("تم الحفظ")), false, code);
  }
});

test("success is reported only after the save promise resolves", async () => {
  let finishSave = null;
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: () => new Promise((resolve) => { finishSave = resolve; }),
    },
  });
  await app.settle();
  prepareStudent(app);

  const pending = app.run("upS()");
  assert.equal(app.alerts.some((item) => item.includes("تم الحفظ")), false);

  finishSave({ ok: true });
  await pending;

  assert.equal(app.alerts.some((item) => item.includes("تم الحفظ")), true);
  assert.equal(app.run("saveError"), "");
});

test("startup waits for the async load before rendering", async () => {
  const data = {
    students: [{ id: "s1", name: "تلميذ محمّل", phone: "", lvl: "", note: "", date: "2026-01-01" }],
    regs: [],
    att: {},
    pays: [],
    prices: {},
    cfg: { name: "المركز", logo: "" },
  };
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: false, data: data }),
      save: async () => ({ ok: true }),
    },
  });
  await app.settle();

  assert.equal(app.run("loadBlocked"), false);
  assert.equal(app.run("D.students[0].name"), "تلميذ محمّل");
  assert.match(app.elements.app.innerHTML, /لوحة القيادة|تلميذ/);
});

test("event delegation dispatches click and change actions", () => {
  const app = loadApp();
  app.run('D=defaultData();tab="dash";sel=null;');

  function target(attrs) {
    return {
      getAttribute(name) {
        return Object.hasOwn(attrs, name) ? attrs[name] : null;
      },
      parentNode: null,
    };
  }

  app.listeners.click({ type: "click", target: target({ "data-action": "go", "data-tab": "tar" }) });
  assert.equal(app.run("tab"), "tar");
  assert.match(app.elements.app.innerHTML, /التعريفة/);

  app.run('D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];tab="stu";sel=null;');
  app.listeners.click({ type: "click", target: target({ "data-action": "open-student", "data-id": "s1" }) });
  assert.equal(app.run("sel"), "s1");
  assert.match(app.elements.app.innerHTML, /أحمد/);

  app.listeners.change({
    type: "change",
    target: Object.assign(target({ "data-action": "attendance-date" }), { value: "2026-02-02" }),
  });
  assert.equal(app.run("aD"), "2026-02-02");
});

test("all six tabs open through delegated navigation", () => {
  const app = loadApp();
  app.run('D=defaultData();tab="dash";sel=null;');
  const pages = {
    dash: /إحصائيات الشهر/,
    stu: /تلميذ جديد/,
    att: /الحضور/,
    pay: /أداء جديد|آخر الأداءات/,
    tar: /التعريفة الشهرية/,
    bc: /رسالة لأولياء الأمور/,
  };

  for (const [tab, expected] of Object.entries(pages)) {
    const target = {
      getAttribute(name) {
        if (name === "data-action") return "go";
        if (name === "data-tab") return tab;
        return null;
      },
      parentNode: null,
    };
    app.listeners.click({ type: "click", target: target });
    assert.equal(app.run("tab"), tab);
    assert.match(app.elements.app.innerHTML, expected, tab);
  }
});

test("dynamic subjects can be added, edited and deleted without touching built-ins or history", async () => {
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: async () => ({ ok: true }),
    },
  });
  await app.settle();
  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.regs=[{id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:180,on:true,date:"2026-01-01"}];
    D.prices={"دعم مدرسي|الرياضيات":200};
    D.subjects=[];tab="tar";sel=null;remember();render();
  `);
  const builtIn = app.run('JSON.stringify(ACT["دعم مدرسي"])');
  assert.match(app.elements.app.innerHTML, /\+ إضافة مادة/);
  assert.match(app.elements.app.innerHTML, /المواد المضافة/);

  app.elements.sa.value = "دعم مدرسي";
  app.elements.sn.value = "الرياضيات";
  app.elements.sp.value = "250";
  await app.run("addSubject()");
  assert.equal(app.run("D.subjects.length"), 0);
  assert.match(app.alerts.at(-1), /كاينة/);

  app.elements.sn.value = "المعلوميات";
  app.elements.sp.value = String(DV.MAX_MONEY + 1);
  await app.run("addSubject()");
  assert.equal(app.run("D.subjects.length"), 0);
  assert.match(app.alerts.at(-1), /غير صالح/);

  app.elements.sp.value = "250";
  await app.run("addSubject()");
  assert.equal(app.run("D.subjects.length"), 1);
  assert.equal(app.run('D.prices["دعم مدرسي|المعلوميات"]'), 250);
  assert.equal(app.run('JSON.stringify(ACT["دعم مدرسي"])'), builtIn);
  assert.equal(app.run('D.prices["دعم مدرسي|الرياضيات"]'), 200);

  app.run(`
    D.regs.push({id:"r2",sid:"s1",act:"دعم مدرسي",sub:"المعلوميات",lvl:"",fee:250,on:true,date:"2026-01-01"});
    D.pays=[{id:"p2",rid:"r2",month:"2026-01",n:1,amt:250,date:"2026-01-02"}];
    D.att={"2026-01-02":{r2:true}};
    remember();
  `);
  const history = app.run("JSON.stringify({regs:D.regs,pays:D.pays,att:D.att})");

  app.run('tab="stu";sel="s1";render();');
  assert.match(app.elements.u.innerHTML, /المعلوميات/);
  app.elements.u.value = "المعلوميات";
  app.run("fillF()");
  assert.equal(String(app.elements.f.value), "250");

  const id = app.run("D.subjects[0].id");
  app.run(`subEdit=${JSON.stringify(id)};subFormOpen=false;tab="tar";render();`);
  app.elements.sn.value = "الإعلاميات";
  app.elements.sp.value = "300";
  await app.run("saveSubject()");
  assert.equal(app.run("D.subjects[0].name"), "الإعلاميات");
  assert.equal(app.run('Object.hasOwn(D.prices,"دعم مدرسي|المعلوميات")'), false);
  assert.equal(app.run('D.prices["دعم مدرسي|الإعلاميات"]'), 300);
  assert.equal(app.run("JSON.stringify({regs:D.regs,pays:D.pays,att:D.att})"), history);
  assert.equal(app.run('JSON.stringify(ACT["دعم مدرسي"])'), builtIn);

  app.run('tab="tar";sel=null;cf="sub"+D.subjects[0].id;render();');
  assert.match(app.elements.app.innerHTML, /تأكيد الحذف/);
  assert.equal(app.run("D.subjects.length"), 1);
  const deleteId = app.run("D.subjects[0].id");
  const target = {
    getAttribute(name) {
      if (name === "data-action") return "ask-delete-subject";
      if (name === "data-id") return deleteId;
      return null;
    },
    parentNode: null,
  };
  app.listeners.click({ type: "click", target: target });
  await app.settle();
  await app.settle();
  assert.equal(app.run("D.subjects.length"), 0);
  assert.equal(app.run('Object.hasOwn(D.prices,"دعم مدرسي|الإعلاميات")'), false);
  assert.equal(app.run("JSON.stringify({regs:D.regs,pays:D.pays,att:D.att})"), history);
  assert.match(app.run('rLabel(D.regs.find(x=>x.id==="r2"))'), /دعم مدرسي – المعلوميات/);
});

test("subject limits follow the activity and names normalize for prices and registration options", async () => {
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: async () => ({ ok: true }),
    },
  });
  await app.settle();
  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    tab="tar";sel=null;subFormOpen=true;remember();render();
  `);

  for (const [act, max] of [["دعم مدرسي", 190], ["لغات", 195], ["تكوين", 194]]) {
    const target = actionTarget({ "data-action": "subject-activity" });
    target.value = act;
    app.listeners.change({ type: "change", target: target });
    assert.equal(app.elements.sn.maxLength, max, act);
  }

  app.elements.sa.value = "دعم مدرسي";
  app.elements.sn.value = "م".repeat(191);
  app.elements.sp.value = "100";
  await app.run("addSubject()");
  assert.equal(app.run("D.subjects.length"), 0);
  assert.match(app.alerts.at(-1), /طويل جدا/);

  app.elements.sn.value = "  مادة   جديدة  ";
  app.elements.sp.value = "120";
  await app.run("addSubject()");
  assert.equal(app.run("D.subjects.length"), 1);
  assert.equal(app.run("D.subjects[0].name"), "مادة جديدة");
  assert.equal(app.run('D.prices["دعم مدرسي|مادة جديدة"]'), 120);

  app.elements.sn.value = " مادة  جديدة ";
  app.elements.sp.value = "120";
  await app.run("addSubject()");
  assert.equal(app.run("D.subjects.length"), 1);
  assert.match(app.alerts.at(-1), /كاينة/);

  app.elements.sn.value = "مادة & خاصة";
  app.elements.sp.value = "130";
  await app.run("addSubject()");
  assert.equal(app.run("D.subjects.length"), 2);

  app.elements.a.value = "دعم مدرسي";
  app.run('tab="stu";sel="s1";render();');
  const options = app.elements.u.innerHTML;
  assert.match(options, /<option value="مادة جديدة">مادة جديدة<\/option>/);
  assert.match(options, /<option value="مادة &amp; خاصة">مادة &amp; خاصة<\/option>/);

  app.elements.u.value = "مادة جديدة";
  app.run("fillF()");
  assert.equal(String(app.elements.f.value), "120");

  app.elements.u.value = "مادة & خاصة";
  app.run("fillF()");
  assert.equal(String(app.elements.f.value), "130");

  app.run(`
    D.subjects.push({id:"sub3",act:"دعم مدرسي",name:"مادة  مزدوجة"});
    D.prices["دعم مدرسي|مادة  مزدوجة"]=140;
    render();
  `);
  assert.match(app.elements.u.innerHTML, /<option value="مادة  مزدوجة">مادة  مزدوجة<\/option>/);
  app.elements.u.value = "مادة  مزدوجة";
  app.run("fillF()");
  assert.equal(String(app.elements.f.value), "140");
});

test("browser save rejects invalid subject data before writing localStorage", async () => {
  const writes = [];
  const app = loadApp({
    localStorage: {
      getItem() { return null; },
      setItem(key, value) { writes.push({ key: key, value: value }); },
    },
  });
  await app.settle();

  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.subjects=[{id:"sub1",act:"لغات",name:"م".repeat(DV.maxSubjectNameLength("لغات")+1)}];
    remember();
  `);
  const rejected = await app.run("save()");
  assert.equal(rejected, false);
  assert.equal(writes.length, 0);
  assert.match(app.run("saveError"), /بيانات غير صالحة/);

  app.run('D.subjects=[{id:"sub1",act:"لغات",name:"م".repeat(DV.maxSubjectNameLength("لغات"))}];');
  const accepted = await app.run("save()");
  assert.equal(accepted, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, "centre_v1");
});

function failingSaveApp() {
  let failing = false;
  const message = "تعذر حفظ المعطيات. لم يتم تعديل الملف الأصلي.";
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: async () => (failing ? { ok: false, code: "WRITE_FAILED", error: message } : { ok: true }),
    },
  });
  return {
    app,
    message,
    fail(value) { failing = value; },
  };
}

function seed(app, source) {
  return app.run(`(async()=>{${source};return save()})()`);
}

test("a failed add student rolls back the in-memory list", async () => {
  const { app, message, fail } = failingSaveApp();
  await app.settle();
  app.elements.n.value = "تلميذ جديد";
  app.elements.p.value = "0600000000";
  app.elements.l.value = "الأولى إعدادي";
  app.elements.no.value = "";

  fail(true);
  await app.run("addS()");

  assert.equal(app.run("D.students.length"), 0);
  assert.equal(app.run("saveError"), message);
  assert.equal(app.alerts.length, 0);
});

test("a failed add payment rolls back the payment list", async () => {
  const { app, message, fail } = failingSaveApp();
  await app.settle();
  await seed(app, `
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.regs=[{id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:200,on:true,date:"2026-01-01"}];
  `);
  app.elements.a.value = "200";
  app.elements.m.value = "2026-01";
  app.elements.k.value = "1";
  app.elements.r.value = "r1";

  fail(true);
  await app.run("addP()");

  assert.equal(app.run("D.pays.length"), 0);
  assert.equal(app.run("D.students.length"), 1);
  assert.equal(app.run("D.regs.length"), 1);
  assert.equal(app.run("msg"), "");
  assert.equal(app.run("saveError"), message);
  assert.equal(app.alerts.some((item) => item.includes("تم الحفظ")), false);
});

test("a failed delete student restores the student and all related data", async () => {
  const { app, message, fail } = failingSaveApp();
  await app.settle();
  await seed(app, `
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.regs=[{id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:200,on:true,date:"2026-01-01"}];
    D.pays=[{id:"p1",rid:"r1",month:"2026-01",n:1,amt:200,date:"2026-01-02"}];
    D.att={"2026-01-02":{"r1":false}};
    sel="s1";tab="stu";
  `);

  fail(true);
  await app.run("delS()");

  assert.equal(app.run("D.students.length"), 1);
  assert.equal(app.run("D.regs.length"), 1);
  assert.equal(app.run("D.pays.length"), 1);
  assert.equal(app.run("D.att['2026-01-02'].r1"), false);
  assert.equal(app.run("saveError"), message);
  assert.equal(app.alerts.some((item) => item.includes("تم الحفظ")), false);
});

test("a failed registration edit rolls back fee and date", async () => {
  const { app, message, fail } = failingSaveApp();
  await app.settle();
  await seed(app, `
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.regs=[{id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:200,on:true,date:"2026-01-01"}];
    sel="s1";tab="stu";
  `);

  fail(true);
  await app.run('sF("r1","350")');
  assert.equal(app.run("D.regs[0].fee"), 200);

  await app.run('sD("r1","2026-05-05")');
  assert.equal(app.run("D.regs[0].date"), "2026-01-01");
  assert.equal(app.run("saveError"), message);
  assert.equal(app.alerts.some((item) => item.includes("تم الحفظ")), false);
});

test("a failed student profile edit rolls back the edited fields", async () => {
  const { app, message, fail } = failingSaveApp();
  await app.settle();
  await seed(app, `
    D=defaultData();
    D.students=[{id:"s1",name:"قديم",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    sel="s1";tab="stu";
  `);
  app.elements.en.value = "جديد";
  app.elements.ep.value = "0612345678";
  app.elements.el.value = "";
  app.elements.eo.value = "";

  fail(true);
  await app.run("upS()");

  assert.equal(app.run("D.students[0].name"), "قديم");
  assert.equal(app.run("D.students[0].phone"), "");
  assert.equal(app.run("saveError"), message);
  assert.equal(app.alerts.some((item) => item.includes("تم الحفظ")), false);
});

function storeData(name) {
  return {
    students: [{ id: "s1", name: name, phone: "", lvl: "", note: "", date: "2026-01-01" }],
    regs: [],
    att: {},
    pays: [],
    prices: {},
    cfg: { name: "المركز", logo: "" },
  };
}

test("after a restore the renderer reloads the store and updates lastSaved", async () => {
  let current = storeData("قديم");
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: false, data: current }),
      save: async () => ({ ok: true }),
      restoreBackup: async () => {
        current = storeData("مسترجع");
        return { ok: true, data: current };
      },
    },
  });
  await app.settle();
  assert.equal(app.run("D.students[0].name"), "قديم");

  await app.run('restoreBk("data-backup.json")');

  assert.equal(app.run("D.students[0].name"), "مسترجع");
  assert.equal(app.run("lastSaved.students[0].name"), "مسترجع");
  assert.equal(app.alerts.some((item) => item.includes("تم استرجاع")), true);
});

test("extreme legacy payment ratios cannot hang month history", () => {
  const app = loadApp();
  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.regs=[{id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:1,on:true,date:"2026-01-01"}];
    D.pays=[{id:"p1",rid:"r1",month:"2026-01",n:1,amt:1e20,date:"2026-01-02"}];
  `);

  assert.match(app.run("mst(D.regs[0])"), /قيمة غير صالحة/);
  assert.match(app.run("endD(D.regs[0])"), /قيمة غير صالحة/);
  assert.equal(app.run("soon().length"), 0);

  app.run(`
    D.regs[0].fee=200;
    D.regs[0].date=today();
    D.pays[0].amt=200;
    D.pays[0].date=today();
  `);
  assert.equal(app.run("stat(D.regs[0]).owed"), 0);
  assert.match(app.run("mst(D.regs[0])"), /✔/);
});

test("numeric UI guards reject out-of-range fees, prices, payments and month counts", async () => {
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: async () => ({ ok: true }),
    },
  });
  await app.settle();
  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    sel="s1";tab="stu";remember();
  `);
  app.elements.a.value = "دعم مدرسي";
  app.elements.u.value = "الرياضيات";
  app.elements.v.value = "";
  app.elements.sd.value = "2026-01-01";
  app.elements.f.value = String(DV.MAX_MONEY + 1);

  await app.run("addR()");
  assert.equal(app.run("D.regs.length"), 0);
  assert.match(app.alerts.at(-1), /كبير جدا/);

  app.run(`
    D.regs=[{id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:200,on:true,date:"2026-01-01"}];
    remember();
  `);
  await app.run(`sF("r1","${DV.MAX_MONEY + 1}")`);
  assert.equal(app.run("D.regs[0].fee"), 200);
  assert.match(app.alerts.at(-1), /غير صالح/);

  await app.run(`setP("دعم مدرسي|الرياضيات","${DV.MAX_MONEY + 1}")`);
  assert.equal(app.run("Object.hasOwn(D.prices,'دعم مدرسي|الرياضيات')"), false);
  assert.match(app.alerts.at(-1), /غير صالح/);

  app.elements.r.value = "r1";
  app.elements.m.value = "2026-01";
  app.elements.k.value = "1";
  app.elements.a.value = String(DV.MAX_MONEY + 1);
  await app.run("addP()");
  assert.equal(app.run("D.pays.length"), 0);
  assert.match(app.alerts.at(-1), /كبير جدا/);

  app.elements.a.value = "200";
  app.elements.k.value = String(DV.MAX_PAYMENT_MONTHS + 1);
  await app.run("addP()");
  assert.equal(app.run("D.pays.length"), 0);
  assert.match(app.alerts.at(-1), /عدد الأشهر غير صالح/);

  app.elements.pr.value = "r1";
  app.elements.pm.value = "2026-01";
  app.elements.pk.value = "1";
  app.elements.pa.value = String(DV.MAX_MONEY + 1);
  await app.run("addPS()");
  assert.equal(app.run("D.pays.length"), 0);
  assert.match(app.alerts.at(-1), /كبير جدا/);
});

function attendanceAppWithControlledSave() {
  const requests = [];
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: (json) => new Promise((resolve) => { requests.push({ json, resolve }); }),
    },
  });
  return { app, requests };
}

function seedAttendance(app) {
  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.regs=[
      {id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:200,on:true,date:"2026-01-01"},
      {id:"r2",sid:"s1",act:"دعم مدرسي",sub:"الفرنسية",lvl:"",fee:200,on:true,date:"2026-01-01"}
    ];
    D.att={};D.pays=[];remember();aD=today();
  `);
  return app.run("aD");
}

test("an older failed save cannot roll back newer successful attendance changes", async () => {
  const { app, requests } = attendanceAppWithControlledSave();
  await app.settle();
  const day = seedAttendance(app);
  const dayPath = JSON.stringify(day);

  const first = app.run('mk("r1")');
  const second = app.run('mk("r2")');
  await app.settle();
  assert.equal(requests.length, 2);

  const firstPayload = JSON.parse(requests[0].json);
  const secondPayload = JSON.parse(requests[1].json);
  assert.equal(firstPayload.att[day].r1, true);
  assert.equal(Object.hasOwn(firstPayload.att[day], "r2"), false);
  assert.equal(secondPayload.att[day].r1, true);
  assert.equal(secondPayload.att[day].r2, true);

  requests[0].resolve({ ok: false, code: "WRITE_FAILED", error: "فشل الحفظ الأول" });
  await first;
  assert.equal(app.run("saveError"), "");
  assert.equal(app.run(`D.att[${dayPath}].r1`), true);
  assert.equal(app.run(`D.att[${dayPath}].r2`), true);

  requests[1].resolve({ ok: true });
  await second;
  assert.equal(app.run("saveError"), "");
  assert.equal(app.run("JSON.stringify(D)"), app.run("JSON.stringify(lastSaved)"));
  assert.equal(requests[1].json, app.run("JSON.stringify(D)"));

  const third = app.run('mk("r1")');
  await app.settle();
  assert.equal(requests.length, 3);
  const thirdPayload = JSON.parse(requests[2].json);
  assert.equal(thirdPayload.att[day].r1, false);
  assert.equal(thirdPayload.att[day].r2, true);

  requests[2].resolve({ ok: true });
  await third;
  assert.equal(app.run(`D.att[${dayPath}].r1`), false);
  assert.equal(app.run(`D.att[${dayPath}].r2`), true);
  assert.equal(app.run("JSON.stringify(D)"), app.run("JSON.stringify(lastSaved)"));
  assert.equal(requests[2].json, app.run("JSON.stringify(D)"));
});

test("rapid successful attendance saves keep UI and persisted state aligned", async () => {
  const { app, requests } = attendanceAppWithControlledSave();
  await app.settle();
  const day = seedAttendance(app);
  const dayPath = JSON.stringify(day);

  const first = app.run('mk("r1")');
  const second = app.run('mk("r2")');
  await app.settle();
  assert.equal(requests.length, 2);

  requests[0].resolve({ ok: true });
  await first;
  requests[1].resolve({ ok: true });
  await second;

  const current = app.run("JSON.stringify(D)");
  assert.equal(app.run(`D.att[${dayPath}].r1`), true);
  assert.equal(app.run(`D.att[${dayPath}].r2`), true);
  assert.equal(app.run("JSON.stringify(lastSaved)"), current);
  assert.equal(requests[1].json, current);
  assert.equal(app.run("saveError"), "");
});

test("consecutive failed saves roll back once and a later save persists the recovered state", async () => {
  const { app, requests } = attendanceAppWithControlledSave();
  await app.settle();
  const day = seedAttendance(app);
  const dayPath = JSON.stringify(day);
  const baseline = app.run("JSON.stringify(lastSaved)");

  const first = app.run('mk("r1")');
  const second = app.run('mk("r2")');
  await app.settle();
  assert.equal(requests.length, 2);

  requests[0].resolve({ ok: false, code: "WRITE_FAILED", error: "فشل الحفظ الأول" });
  await first;
  assert.equal(app.run("saveError"), "");
  assert.equal(app.run(`D.att[${dayPath}].r1`), true);
  assert.equal(app.run(`D.att[${dayPath}].r2`), true);

  requests[1].resolve({ ok: false, code: "WRITE_FAILED", error: "فشل الحفظ الثاني" });
  await second;
  assert.equal(app.run("saveError"), "فشل الحفظ الثاني");
  assert.equal(app.run("JSON.stringify(D)"), baseline);
  assert.equal(app.run("JSON.stringify(lastSaved)"), baseline);
  assert.equal(app.run("Object.keys(D.att).length"), 0);

  const third = app.run('mk("r1")');
  await app.settle();
  assert.equal(requests.length, 3);
  const thirdPayload = JSON.parse(requests[2].json);
  assert.equal(thirdPayload.att[day].r1, true);
  assert.equal(Object.hasOwn(thirdPayload.att[day], "r2"), false);

  requests[2].resolve({ ok: true });
  await third;
  assert.equal(app.run("saveError"), "");
  assert.equal(app.run(`D.att[${dayPath}].r1`), true);
  assert.equal(app.run(`D.att[${dayPath}].r2`), undefined);
  assert.equal(app.run("JSON.stringify(D)"), app.run("JSON.stringify(lastSaved)"));
  assert.equal(requests[2].json, app.run("JSON.stringify(D)"));
});

function shutdownApp() {
  const requests = [];
  const readies = [];
  let closingHandler = null;
  const app = loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: (json) => new Promise((resolve) => { requests.push({ json, resolve }); }),
      onClosing(handler) {
        closingHandler = handler;
      },
      closeReady() {
        readies.push(true);
      },
    },
  });
  return {
    app,
    requests,
    readies,
    close() {
      assert.equal(typeof closingHandler, "function", "closing handler missing");
      return closingHandler();
    },
  };
}

function actionTarget(attrs) {
  return {
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    parentNode: null,
  };
}

test("close waits for an in-flight save before acknowledging shutdown", async () => {
  const { app, requests, readies, close } = shutdownApp();
  await app.settle();
  const day = seedAttendance(app);
  const dayPath = JSON.stringify(day);

  const action = app.run('trackAction(mk("r1"))');
  await app.settle();
  assert.equal(requests.length, 1);

  const closing = close();
  await app.settle();
  assert.equal(readies.length, 0);
  assert.equal(app.run("shuttingDown"), true);

  requests[0].resolve({ ok: true });
  await action;
  await closing;
  await app.settle();

  assert.equal(readies.length, 1);
  assert.equal(app.run(`D.att[${dayPath}].r1`), true);
});

test("a delayed action can submit its save after close begins but before acknowledgment", async () => {
  const { app, requests, readies, close } = shutdownApp();
  await app.settle();
  const day = seedAttendance(app);
  const dayPath = JSON.stringify(day);

  const action = app.run(`
    trackAction(new Promise((resolve) => {
      globalThis.finishDelayedAction = () => { mk("r1").then(resolve); };
    }))
  `);
  await app.settle();
  assert.equal(requests.length, 0);

  const closing = close();
  await app.settle();
  assert.equal(readies.length, 0);

  app.run("finishDelayedAction()");
  await app.settle();
  assert.equal(requests.length, 1);
  assert.equal(readies.length, 0);

  requests[0].resolve({ ok: true });
  await action;
  await closing;

  assert.equal(readies.length, 1);
  assert.equal(app.run(`D.att[${dayPath}].r1`), true);
});

test("repeated close requests acknowledge once and ignore new user actions", async () => {
  const { app, requests, readies, close } = shutdownApp();
  await app.settle();
  seedAttendance(app);

  const action = app.run('trackAction(mk("r1"))');
  await app.settle();
  const first = close();
  const second = close();
  assert.equal(first, second);
  await app.settle();

  app.listeners.click({
    type: "click",
    target: actionTarget({ "data-action": "toggle-attendance", "data-id": "r2" }),
  });
  await app.settle();
  assert.equal(requests.length, 1);
  assert.equal(readies.length, 0);

  requests[0].resolve({ ok: true });
  await action;
  await Promise.all([first, second]);
  await app.settle();

  assert.equal(readies.length, 1);
  close();
  await app.settle();
  assert.equal(readies.length, 1);
});

test("a failed save during shutdown is surfaced and still acknowledges close", async () => {
  const { app, requests, readies, close } = shutdownApp();
  await app.settle();
  seedAttendance(app);
  const message = "تعذر حفظ المعطيات. لم يتم تعديل الملف الأصلي.";

  const action = app.run('trackAction(mk("r1"))');
  await app.settle();
  const closing = close();
  await app.settle();
  assert.equal(readies.length, 0);

  requests[0].resolve({ ok: false, code: "WRITE_FAILED", error: message });
  await action;
  await closing;
  await app.settle();

  assert.equal(app.run("saveError"), message);
  assert.equal(readies.length, 1);
});

function financialApp() {
  return loadApp({
    userAgent: "Electron/33",
    desktop: {
      load: async () => ({ ok: true, firstRun: true }),
      save: async () => ({ ok: true }),
    },
  });
}

function seedFinancial(app, pays) {
  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.regs=[{id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:200,on:true,date:"2026-01-01"}];
    D.pays=${JSON.stringify(pays)};
    remember();
  `);
}

function dashboardIncome(app, month) {
  app.run(`dM=${JSON.stringify(month)}`);
  const html = app.run("dash()");
  const match = /class="ok">([^<]+)<\/b>درهم مقبوض/.exec(html);
  assert.ok(match, "dashboard income missing for " + month);
  return Number(match[1]);
}

test("income follows the payment date, not the covered service month", async () => {
  const app = financialApp();
  await app.settle();
  seedFinancial(app, [
    { id: "p1", rid: "r1", month: "2026-01", n: 1, amt: 250, date: "2026-02-05" },
  ]);

  assert.equal(dashboardIncome(app, "2026-01"), 0);
  assert.equal(dashboardIncome(app, "2026-02"), 250);
  assert.equal(app.run("D.pays[0].month"), "2026-01");
  assert.match(app.run("dash()"), /إحصائيات الشهر \(حسب تاريخ الأداء\)/);
});

test("multiple payments are grouped by actual date while covered months stay preserved", async () => {
  const app = financialApp();
  await app.settle();
  seedFinancial(app, [
    { id: "p1", rid: "r1", month: "2026-01", n: 1, amt: 100, date: "2026-02-05" },
    { id: "p2", rid: "r1", month: "2026-02", n: 1, amt: 200, date: "2026-02-20" },
    { id: "p3", rid: "r1", month: "2026-02", n: 2, amt: 300, date: "2026-03-01" },
    { id: "p4", rid: "r1", month: "2026-01", n: 1, amt: 400, date: "2026-01-31" },
  ]);

  assert.equal(dashboardIncome(app, "2026-01"), 400);
  assert.equal(dashboardIncome(app, "2026-02"), 300);
  assert.equal(dashboardIncome(app, "2026-03"), 300);
  assert.equal(app.run("D.pays.map(p=>p.month).join(',')"), "2026-01,2026-02,2026-02,2026-01");
});

test("month boundaries use the actual payment date on both sides of the boundary", async () => {
  const app = financialApp();
  await app.settle();
  seedFinancial(app, [
    { id: "p1", rid: "r1", month: "2026-01", n: 1, amt: 50, date: "2025-12-31" },
    { id: "p2", rid: "r1", month: "2025-12", n: 1, amt: 70, date: "2026-01-01" },
  ]);

  assert.equal(dashboardIncome(app, "2025-12"), 50);
  assert.equal(dashboardIncome(app, "2026-01"), 70);
  assert.equal(dashboardIncome(app, "2026-02"), 0);
});

test("payment history and receipts keep the actual date and the covered service period visible", async () => {
  const app = financialApp();
  await app.settle();
  seedFinancial(app, [
    { id: "p1", rid: "r1", month: "2026-01", n: 3, amt: 600, date: "2026-02-05" },
  ]);
  app.run('tab="pay";');

  const history = app.run("pay()");
  assert.ok(history.includes("2026-02-05"));
  assert.ok(history.includes("2026-01"));

  const detail = app.run('sel="s1";detail()');
  assert.ok(detail.includes("2026-02-05"));
  assert.ok(detail.includes("2026-01"));
  assert.ok(detail.includes("3 أشهر"));

  const receipt = app.run('rc("p1",1);msg');
  assert.match(receipt, /التاريخ: 2026-02-05/);
  assert.match(receipt, /الشهر: 2026-01 إلى 2026-03/);
  assert.match(receipt, /المبلغ المؤدى: 600 درهم/);
});

test("both payment forms save the explicit actual payment date and reject a missing one", async () => {
  const app = financialApp();
  await app.settle();
  app.run(`
    D=defaultData();
    D.students=[{id:"s1",name:"أحمد",phone:"",lvl:"",note:"",date:"2026-01-01"}];
    D.regs=[{id:"r1",sid:"s1",act:"دعم مدرسي",sub:"الرياضيات",lvl:"",fee:200,on:true,date:"2026-01-01"}];
    sel="s1";tab="pay";remember();
  `);

  app.elements.r.value = "r1";
  app.elements.m.value = "2026-01";
  app.elements.k.value = "1";
  app.elements.a.value = "200";
  app.elements.pd.value = "2026-02-05";
  await app.run("addP()");

  assert.equal(app.run("D.pays.length"), 1);
  assert.equal(app.run("D.pays[0].date"), "2026-02-05");
  assert.equal(app.run("D.pays[0].month"), "2026-01");

  app.elements.pr.value = "r1";
  app.elements.pm.value = "2026-03";
  app.elements.pk.value = "2";
  app.elements.pa.value = "400";
  app.elements.pd.value = "2026-04-10";
  await app.run("addPS()");

  assert.equal(app.run("D.pays.length"), 2);
  assert.equal(app.run("D.pays[1].date"), "2026-04-10");
  assert.equal(app.run("D.pays[1].month"), "2026-03");
  assert.equal(app.run("D.pays[1].n"), 2);

  app.elements.pd.value = "";
  await app.run("addP()");
  assert.equal(app.run("D.pays.length"), 2);
  assert.match(app.alerts.at(-1), /تاريخ الأداء غير صالح/);
});
