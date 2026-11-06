const test = require("node:test");
const assert = require("node:assert/strict");
const DV = require("../data-validation");

function base() {
  return {
    students: [{
      id: "s1",
      name: "أحمد <script>alert(1)</script>",
      phone: "0612345678",
      lvl: "الأول ابتدائي",
      note: "ملاحظة",
      date: "2026-01-01",
    }],
    regs: [{
      id: "r1",
      sid: "s1",
      act: "دعم مدرسي",
      sub: "الرياضيات",
      lvl: "الأول ابتدائي",
      fee: 200,
      on: true,
      date: "2026-01-01",
    }],
    att: { "2026-01-02": { r1: true } },
    pays: [{
      id: "p1",
      rid: "r1",
      month: "2026-01",
      n: 1,
      amt: 200,
      date: "2026-01-02",
    }],
    prices: { "دعم مدرسي|الرياضيات": 200 },
    cfg: { name: "المركز", logo: "" },
  };
}

test("accepts the current data shape in load and import modes", () => {
  for (const mode of ["load", "import"]) {
    const result = DV.validateData(base(), { mode });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.students[0].name, "أحمد <script>alert(1)</script>");
  }
});

test("load mode preserves harmless unknown fields and import mode strips them", () => {
  const input = base();
  input.futureField = { keep: true };
  input.students[0].extra = "keep";
  const loaded = DV.validateData(input, { mode: "load" });
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.data.futureField.keep, true);
  assert.equal(loaded.data.students[0].extra, "keep");

  const imported = DV.validateData(input, { mode: "import" });
  assert.equal(imported.ok, true, imported.error);
  assert.equal(Object.hasOwn(imported.data, "futureField"), false);
  assert.equal(Object.hasOwn(imported.data.students[0], "extra"), false);
});

test("load mode supplies legacy defaults for missing prices and cfg without losing extras", () => {
  const input = base();
  delete input.prices;
  delete input.cfg;
  const loaded = DV.validateData(input, { mode: "load" });
  assert.equal(loaded.ok, true, loaded.error);
  assert.deepEqual(loaded.data.prices, {});
  assert.equal(loaded.data.cfg.name, "تسيير المركز");
  assert.equal(loaded.data.cfg.logo, "");
  assert.equal(loaded.data.students[0].name, input.students[0].name);

  const partial = base();
  partial.cfg = { name: "قديم", custom: "keep" };
  const merged = DV.validateData(partial, { mode: "load" });
  assert.equal(merged.ok, true, merged.error);
  assert.equal(merged.data.cfg.name, "قديم");
  assert.equal(merged.data.cfg.logo, "");
  assert.equal(merged.data.cfg.custom, "keep");
});

test("loads old data without subjects as an empty array and preserves dynamic subjects", () => {
  const legacy = base();
  for (const mode of ["load", "import"]) {
    const result = DV.validateData(legacy, { mode });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.data.subjects, []);
  }

  const withSubjects = base();
  withSubjects.subjects = [{ id: "sub1", act: "دعم مدرسي", name: "المعلوميات" }];
  withSubjects.prices["دعم مدرسي|المعلوميات"] = 250;
  for (const mode of ["load", "import"]) {
    const result = DV.validateData(withSubjects, { mode });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.data.subjects, withSubjects.subjects);
    assert.equal(result.data.prices["دعم مدرسي|المعلوميات"], 250);
  }

  const max = base();
  max.subjects = [{ id: "sub1", act: "دعم مدرسي", name: "المعلوميات" }];
  max.prices["دعم مدرسي|المعلوميات"] = DV.MAX_MONEY;
  assert.equal(DV.validateData(max, { mode: "import" }).ok, true);

  const tooHigh = base();
  tooHigh.subjects = [{ id: "sub1", act: "دعم مدرسي", name: "المعلوميات" }];
  tooHigh.prices["دعم مدرسي|المعلوميات"] = DV.MAX_MONEY + 1;
  for (const mode of ["load", "import"]) {
    assert.equal(DV.validateData(tooHigh, { mode }).ok, false, mode);
  }
});

test("rejects invalid, duplicate and built-in dynamic subjects", () => {
  const cases = [
    ["id", (s) => { s[0].id = "bad id"; }],
    ["duplicate id", (s) => { s.push({ id: "sub1", act: "لغات", name: "الألمانية" }); }],
    ["missing act", (s) => { delete s[0].act; }],
    ["invalid act", (s) => { s[0].act = "نشاط غير موجود"; }],
    ["empty name", (s) => { s[0].name = "   "; }],
    ["duplicate name", (s) => { s.push({ id: "sub2", act: "دعم مدرسي", name: "المعلوميات" }); }],
    ["built-in name", (s) => { s[0].name = "الرياضيات"; }],
    ["pipe name", (s) => { s[0].name = "مادة|أخرى"; }],
  ];
  for (const [name, mutate] of cases) {
    const input = base();
    input.subjects = [{ id: "sub1", act: "دعم مدرسي", name: "المعلوميات" }];
    mutate(input.subjects);
    for (const mode of ["load", "import"]) {
      const result = DV.validateData(input, { mode });
      assert.equal(result.ok, false, name + " " + mode);
    }
  }

  const dangerous = base();
  dangerous.subjects = [{ id: "sub1", act: "دعم مدرسي", name: "المعلوميات" }];
  Object.defineProperty(dangerous.subjects[0], "constructor", { value: "x", enumerable: true });
  const result = DV.validateData(dangerous, { mode: "import" });
  assert.equal(result.ok, false);
  assert.match(result.error, /مفتاح غير مسموح/);
});

test("rejects prototype-pollution keys at every object level", () => {
  const cases = [];
  const root = base();
  Object.defineProperty(root, "__proto__", { value: {}, enumerable: true });
  cases.push(root);
  const student = base();
  Object.defineProperty(student.students[0], "constructor", { value: "x", enumerable: true });
  cases.push(student);
  const attendance = base();
  Object.defineProperty(attendance.att, "prototype", { value: {}, enumerable: true });
  cases.push(attendance);
  for (const value of cases) {
    const result = DV.validateData(value, { mode: "import" });
    assert.equal(result.ok, false);
    assert.match(result.error, /مفتاح غير مسموح/);
  }
});

test("accepts legacy-safe ids and rejects unsafe or duplicate ids", () => {
  const legacy = base();
  legacy.students[0].id = "Abc_123-xyz";
  legacy.regs[0].sid = "Abc_123-xyz";
  assert.equal(DV.validateData(legacy, { mode: "import" }).ok, true);

  const bad = base();
  bad.students[0].id = "bad id";
  assert.equal(DV.validateData(bad, { mode: "import" }).ok, false);

  const duplicate = base();
  duplicate.students.push({ ...duplicate.students[0] });
  assert.equal(DV.validateData(duplicate, { mode: "import" }).ok, false);
});

test("enforces referential integrity for regs, pays and attendance", () => {
  const orphanReg = base();
  orphanReg.regs[0].sid = "missing";
  assert.equal(DV.validateData(orphanReg, { mode: "import" }).ok, false);

  const orphanPay = base();
  orphanPay.pays[0].rid = "missing";
  assert.equal(DV.validateData(orphanPay, { mode: "import" }).ok, false);

  const orphanAtt = base();
  orphanAtt.att["2026-01-02"] = { missing: true };
  assert.equal(DV.validateData(orphanAtt, { mode: "import" }).ok, false);

  const badAtt = base();
  badAtt.att["2026-01-02"].r1 = "yes";
  assert.equal(DV.validateData(badAtt, { mode: "import" }).ok, false);
});

test("validates real dates, months and payment amounts", () => {
  const leap = base();
  leap.regs[0].date = "2024-02-29";
  leap.pays[0].date = "2024-02-29";
  leap.att = { "2024-02-29": { r1: true } };
  assert.equal(DV.validateData(leap, { mode: "import" }).ok, true);

  const badDay = base();
  badDay.regs[0].date = "2026-02-30";
  assert.equal(DV.validateData(badDay, { mode: "import" }).ok, false);

  const badMonth = base();
  badMonth.pays[0].month = "2026-13";
  assert.equal(DV.validateData(badMonth, { mode: "import" }).ok, false);

  const negative = base();
  negative.pays[0].amt = -1;
  assert.equal(DV.validateData(negative, { mode: "import" }).ok, false);

  const fractionalCount = base();
  fractionalCount.pays[0].n = 1.5;
  assert.equal(DV.validateData(fractionalCount, { mode: "import" }).ok, false);
});

test("enforces safe upper bounds for money fields and payment month counts", () => {
  const max = base();
  max.regs[0].fee = DV.MAX_MONEY;
  max.pays[0].amt = DV.MAX_MONEY;
  max.pays[0].n = DV.MAX_PAYMENT_MONTHS;
  max.prices["دعم مدرسي|الرياضيات"] = DV.MAX_MONEY;
  for (const mode of ["load", "import"]) {
    const result = DV.validateData(max, { mode });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.regs[0].fee, DV.MAX_MONEY);
    assert.equal(result.data.pays[0].amt, DV.MAX_MONEY);
    assert.equal(result.data.pays[0].n, DV.MAX_PAYMENT_MONTHS);
    assert.equal(result.data.prices["دعم مدرسي|الرياضيات"], DV.MAX_MONEY);
  }

  const cases = [
    ["fee", (input) => { input.regs[0].fee = DV.MAX_MONEY + 1; }],
    ["amount", (input) => { input.pays[0].amt = DV.MAX_MONEY + 1; }],
    ["months", (input) => { input.pays[0].n = DV.MAX_PAYMENT_MONTHS + 1; }],
    ["price", (input) => { input.prices["دعم مدرسي|الرياضيات"] = DV.MAX_MONEY + 1; }],
  ];
  for (const [name, mutate] of cases) {
    const input = base();
    mutate(input);
    for (const mode of ["load", "import"]) {
      const result = DV.validateData(input, { mode });
      assert.equal(result.ok, false, name + " " + mode);
      assert.match(result.error, /كبير جدا/);
    }
  }
});

test("rejects non-finite and unsafe numeric values while preserving decimals", () => {
  const decimal = base();
  decimal.regs[0].fee = 99.5;
  decimal.pays[0].amt = 99.5;
  decimal.prices["دعم مدرسي|الرياضيات"] = 99.5;
  for (const mode of ["load", "import"]) {
    const result = DV.validateData(decimal, { mode });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.regs[0].fee, 99.5);
    assert.equal(result.data.pays[0].amt, 99.5);
    assert.equal(result.data.prices["دعم مدرسي|الرياضيات"], 99.5);
  }

  const zero = base();
  zero.regs[0].fee = 0;
  zero.pays[0].amt = 0;
  zero.prices["دعم مدرسي|الرياضيات"] = 0;
  assert.equal(DV.validateData(zero, { mode: "import" }).ok, true);

  const setField = (input, field, value) => {
    if (field === "fee") input.regs[0].fee = value;
    else if (field === "amt") input.pays[0].amt = value;
    else if (field === "n") input.pays[0].n = value;
    else input.prices["دعم مدرسي|الرياضيات"] = value;
  };
  const invalid = [
    ["fee", -1], ["fee", Infinity], ["fee", -Infinity], ["fee", NaN],
    ["amt", -1], ["amt", Infinity], ["amt", -Infinity], ["amt", NaN],
    ["price", -1], ["price", Infinity], ["price", -Infinity], ["price", NaN],
    ["n", 0], ["n", -1], ["n", 1.5], ["n", Infinity], ["n", NaN],
  ];
  for (const [field, value] of invalid) {
    const input = base();
    setField(input, field, value);
    for (const mode of ["load", "import"]) {
      const result = DV.validateData(input, { mode });
      assert.equal(result.ok, false, field + " " + String(value) + " " + mode);
    }
  }
});

test("load mode tolerates legacy blank payment month and attendance date keys", () => {
  const legacy = base();
  legacy.pays[0].month = "";
  legacy.att = { "": { r1: true } };
  assert.equal(DV.validateData(legacy, { mode: "load" }).ok, true);
  assert.equal(DV.validateData(legacy, { mode: "import" }).ok, false);
});

test("requires the accounting fields the app relies on during import", () => {
  const missingFee = base();
  delete missingFee.regs[0].fee;
  assert.equal(DV.validateData(missingFee, { mode: "import" }).ok, false);

  const missingOn = base();
  delete missingOn.regs[0].on;
  assert.equal(DV.validateData(missingOn, { mode: "import" }).ok, false);

  const missingAmount = base();
  delete missingAmount.pays[0].amt;
  assert.equal(DV.validateData(missingAmount, { mode: "import" }).ok, false);
});

test("only accepts image data URLs for the logo", () => {
  const withLogo = base();
  withLogo.cfg.logo = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(DV.validateData(withLogo, { mode: "import" }).ok, true);

  for (const logo of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "https://example.com/x.png"]) {
    const value = base();
    value.cfg.logo = logo;
    assert.equal(DV.validateData(value, { mode: "import" }).ok, false, logo);
  }
});

test("escapes HTML in text and preserves local date formatting", () => {
  assert.equal(DV.escapeHtml("<a href=\"x\">&'</a>"), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(DV.escapeHtml(null), "");
  assert.equal(DV.localDate(new Date(2026, 0, 2, 23, 59, 59)), "2026-01-02");
  assert.equal(DV.localMonth(new Date(2026, 10, 2)), "2026-11");
  assert.equal(DV.validId("0abc_DEF-9"), true);
  assert.equal(DV.validId("x".repeat(65)), false);
});

test("payment dates are required and never invented for legacy records", () => {
  const missing = base();
  delete missing.pays[0].date;
  const blank = base();
  blank.pays[0].date = "";

  for (const mode of ["load", "import"]) {
    const missingResult = DV.validateData(missing, { mode });
    assert.equal(missingResult.ok, false, mode);
    assert.match(missingResult.error, /pays\[0\]\.date/);

    const blankResult = DV.validateData(blank, { mode });
    assert.equal(blankResult.ok, false, mode);
    assert.match(blankResult.error, /pays\[0\]\.date/);
  }
});

test("enforces the composite activity|subject price-key length", () => {
  for (const act of Object.keys(DV.ACT)) {
    const max = DV.maxSubjectNameLength(act);
    assert.equal(act.length + 1 + max, DV.MAX_PRICE_KEY_LENGTH, act);

    const name = "م".repeat(max);
    const key = act + "|" + name;
    assert.equal(key.length, DV.MAX_PRICE_KEY_LENGTH, act);

    const atLimit = base();
    atLimit.subjects = [{ id: "sub1", act: act, name: name }];
    atLimit.prices = { [key]: 100 };
    for (const mode of ["load", "import"]) {
      const result = DV.validateData(atLimit, { mode });
      assert.equal(result.ok, true, act + " " + mode + " " + (result.error || ""));
      assert.equal(result.data.subjects[0].name, name);
      assert.equal(result.data.prices[key], 100);
    }

    const overLimit = base();
    overLimit.subjects = [{ id: "sub1", act: act, name: "م".repeat(max + 1) }];
    for (const mode of ["load", "import"]) {
      const result = DV.validateData(overLimit, { mode });
      assert.equal(result.ok, false, act + " over limit " + mode);
      assert.match(result.error, /طويل جدا/);
    }
  }
});

test("applies a different subject-name limit for each activity length", () => {
  const limits = {
    "دعم مدرسي": 190,
    "لغات": 195,
    "تكوين": 194,
  };
  for (const [act, expected] of Object.entries(limits)) {
    assert.equal(DV.maxSubjectNameLength(act), expected, act);
  }

  const accepted = (act, length) => {
    const input = base();
    input.subjects = [{ id: "sub1", act: act, name: "م".repeat(length) }];
    const result = DV.validateData(input, { mode: "import" });
    assert.equal(result.ok, true, act + " " + length + " " + (result.error || ""));
  };
  const rejected = (act, length) => {
    const input = base();
    input.subjects = [{ id: "sub1", act: act, name: "م".repeat(length) }];
    const result = DV.validateData(input, { mode: "import" });
    assert.equal(result.ok, false, act + " " + length);
    assert.match(result.error, /طويل جدا/);
  };

  accepted("دعم مدرسي", 190);
  rejected("دعم مدرسي", 191);
  accepted("لغات", 195);
  accepted("تكوين", 194);
  rejected("تكوين", 195);
});

test("normalizes dynamic subject whitespace and keeps historical records unchanged", () => {
  const input = base();
  const rawName = "  المعلوميات   الإدارية  ";
  const canonical = "المعلوميات الإدارية";
  input.subjects = [{ id: "sub1", act: "دعم مدرسي", name: rawName }];
  input.prices = { ["دعم مدرسي|" + rawName]: 250 };
  input.regs[0].sub = rawName;

  for (const mode of ["load", "import"]) {
    const result = DV.validateData(input, { mode });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.subjects[0].name, canonical);
    assert.equal(result.data.prices["دعم مدرسي|" + rawName], 250);
    assert.equal(result.data.prices["دعم مدرسي|" + canonical], 250);
    assert.deepEqual(result.data.regs, input.regs);
    assert.deepEqual(result.data.pays, input.pays);
    assert.deepEqual(result.data.att, input.att);
    assert.deepEqual(result.data.students, input.students);
  }

  const empty = base();
  empty.subjects = [{ id: "sub1", act: "دعم مدرسي", name: " \t\n " }];
  assert.equal(DV.validateData(empty, { mode: "import" }).ok, false);
});

test("detects duplicate dynamic subjects after whitespace normalization", () => {
  const pairs = [
    ["المعلوميات", "  المعلوميات  "],
    ["مادة  جديدة", "مادة جديدة"],
  ];
  for (const [first, second] of pairs) {
    const input = base();
    input.subjects = [
      { id: "sub1", act: "دعم مدرسي", name: first },
      { id: "sub2", act: "دعم مدرسي", name: second },
    ];
    for (const mode of ["load", "import"]) {
      const result = DV.validateData(input, { mode });
      assert.equal(result.ok, false, first + " / " + second + " " + mode);
      assert.match(result.error, /مادة مكررة/);
    }
  }
});
