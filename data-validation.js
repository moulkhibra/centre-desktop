(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DataValidation = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_JSON_BYTES = 25 * 1024 * 1024;
  const MAX_LOGO_LENGTH = 4 * 1024 * 1024;
  const MAX_MONEY = 1000000;
  const MAX_PAYMENT_MONTHS = 120;
  const MAX_PRICE_KEY_LENGTH = 200;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const MONTH_RE = /^(\d{4})-(\d{2})$/;
  const LOGO_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
  const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
  const ACT = {
    "دعم مدرسي": ["الرياضيات", "الفيزياء", "علوم الحياة والأرض", "الفرنسية", "العربية", "الإنجليزية", "مواد أخرى"],
    "لغات": ["الإنجليزية", "الفرنسية", "الألمانية", "الإسبانية", "الإيطالية"],
    "تكوين": ["دورة تكوينية", "توجيه مدرسي", "تحضير المباريات", "تحضير الامتحانات"],
  };

  function ok(data) {
    return { ok: true, data: data };
  }

  function bad(path, reason) {
    return { ok: false, error: "بيانات غير صالحة عند " + path + ": " + reason };
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function checkKeys(value, path) {
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) return bad(path + "." + key, "مفتاح غير مسموح");
    }
    return null;
  }

  function validDate(value) {
    if (typeof value !== "string") return false;
    const match = DATE_RE.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function validMonth(value) {
    if (typeof value !== "string") return false;
    const match = MONTH_RE.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return year >= 1900 && year <= 9999 && month >= 1 && month <= 12;
  }

  function validId(value) {
    return typeof value === "string" && ID_RE.test(value);
  }

  function validLogo(value) {
    if (value === "") return true;
    return typeof value === "string" && value.length <= MAX_LOGO_LENGTH && LOGO_RE.test(value);
  }

  function normalizeSubjectName(value) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim();
  }

  function maxSubjectNameLength(activity) {
    const act = typeof activity === "string" ? activity : "";
    return MAX_PRICE_KEY_LENGTH - act.length - 1;
  }

  function optionalString(value, fallback, max, path) {
    if (value === undefined || value === null) return { ok: true, value: fallback };
    if (typeof value !== "string") return bad(path, "يجب أن يكون نصا");
    if (value.length > max) return bad(path, "طويل جدا");
    return { ok: true, value: value };
  }

  function requiredString(value, max, path) {
    const result = optionalString(value, "", max, path);
    if (!result.ok) return result;
    if (result.value.trim() === "") return bad(path, "مطلوب");
    return result;
  }

  function optionalNumber(value, fallback, min, path, max) {
    if (value === undefined || value === null) return { ok: true, value: fallback };
    if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
      return bad(path, "يجب أن يكون رقما صالحا");
    }
    if (max !== undefined && value > max) return bad(path, "كبير جدا");
    return { ok: true, value: value };
  }

  function requiredNumber(value, min, path, max) {
    if (value === undefined || value === null) return bad(path, "مطلوب");
    return optionalNumber(value, 0, min, path, max);
  }

  function optionalBoolean(value, fallback, path) {
    if (value === undefined || value === null) return { ok: true, value: fallback };
    if (typeof value !== "boolean") return bad(path, "يجب أن يكون صحيحا أو خطأ");
    return { ok: true, value: value };
  }

  function validateStudents(input, mode) {
    if (!Array.isArray(input)) return bad("students", "يجب أن تكون لائحة");
    const output = [];
    const ids = new Set();
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      const path = "students[" + index + "]";
      if (!isPlainObject(item)) return bad(path, "يجب أن يكون كائنا");
      const keyError = checkKeys(item, path);
      if (keyError) return keyError;
      if (!validId(item.id)) return bad(path + ".id", "معرف غير صالح");
      if (ids.has(item.id)) return bad(path + ".id", "معرف مكرر");
      ids.add(item.id);
      const name = requiredString(item.name, 300, path + ".name");
      if (!name.ok) return name;
      const phone = optionalString(item.phone, "", 80, path + ".phone");
      if (!phone.ok) return phone;
      const lvl = optionalString(item.lvl, "", 100, path + ".lvl");
      if (!lvl.ok) return lvl;
      const note = optionalString(item.note, "", 2000, path + ".note");
      if (!note.ok) return note;
      const date = optionalString(item.date, "", 10, path + ".date");
      if (!date.ok) return date;
      if (date.value === "") {
        if (mode === "import") return bad(path + ".date", "تاريخ مطلوب");
      } else if (!validDate(date.value)) {
        return bad(path + ".date", "تاريخ غير صالح");
      }
      output.push({
        id: item.id,
        name: name.value,
        phone: phone.value,
        lvl: lvl.value,
        note: note.value,
        date: date.value,
      });
    }
    return { ok: true, data: output, ids: ids };
  }

  function validateRegs(input, mode, studentIds) {
    if (!Array.isArray(input)) return bad("regs", "يجب أن تكون لائحة");
    const output = [];
    const ids = new Set();
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      const path = "regs[" + index + "]";
      if (!isPlainObject(item)) return bad(path, "يجب أن يكون كائنا");
      const keyError = checkKeys(item, path);
      if (keyError) return keyError;
      if (!validId(item.id)) return bad(path + ".id", "معرف غير صالح");
      if (ids.has(item.id)) return bad(path + ".id", "معرف مكرر");
      if (!validId(item.sid)) return bad(path + ".sid", "معرف التلميذ غير صالح");
      if (!studentIds.has(item.sid)) return bad(path + ".sid", "التلميذ غير موجود");
      const act = requiredString(item.act, 200, path + ".act");
      if (!act.ok) return act;
      const sub = optionalString(item.sub, "", 200, path + ".sub");
      if (!sub.ok) return sub;
      const lvl = optionalString(item.lvl, "", 100, path + ".lvl");
      if (!lvl.ok) return lvl;
      const fee = optionalNumber(item.fee, mode === "import" ? undefined : 0, 0, path + ".fee", MAX_MONEY);
      if (!fee.ok) return fee;
      if (fee.value === undefined) return bad(path + ".fee", "مطلوب");
      const on = optionalBoolean(item.on, mode === "import" ? undefined : false, path + ".on");
      if (!on.ok) return on;
      if (on.value === undefined) return bad(path + ".on", "مطلوب");
      if (!validDate(item.date)) return bad(path + ".date", "تاريخ غير صالح");
      ids.add(item.id);
      output.push({
        id: item.id,
        sid: item.sid,
        act: act.value,
        sub: sub.value,
        lvl: lvl.value,
        fee: fee.value,
        on: on.value,
        date: item.date,
      });
    }
    return { ok: true, data: output, ids: ids };
  }

  function validatePays(input, regIds, mode) {
    if (!Array.isArray(input)) return bad("pays", "يجب أن تكون لائحة");
    const output = [];
    const ids = new Set();
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      const path = "pays[" + index + "]";
      if (!isPlainObject(item)) return bad(path, "يجب أن يكون كائنا");
      const keyError = checkKeys(item, path);
      if (keyError) return keyError;
      if (!validId(item.id)) return bad(path + ".id", "معرف غير صالح");
      if (ids.has(item.id)) return bad(path + ".id", "معرف مكرر");
      if (!validId(item.rid)) return bad(path + ".rid", "معرف التسجيل غير صالح");
      if (!regIds.has(item.rid)) return bad(path + ".rid", "التسجيل غير موجود");
      if (!(mode === "load" && item.month === "") && !validMonth(item.month)) {
        return bad(path + ".month", "شهر غير صالح");
      }
      const count = optionalNumber(item.n, 1, 1, path + ".n", MAX_PAYMENT_MONTHS);
      if (!count.ok) return count;
      if (!Number.isInteger(count.value)) return bad(path + ".n", "يجب أن يكون عددا صحيحا");
      const amount = requiredNumber(item.amt, 0, path + ".amt", MAX_MONEY);
      if (!amount.ok) return amount;
      if (!validDate(item.date)) return bad(path + ".date", "تاريخ غير صالح");
      ids.add(item.id);
      output.push({
        id: item.id,
        rid: item.rid,
        month: item.month,
        n: count.value,
        amt: amount.value,
        date: item.date,
      });
    }
    return { ok: true, data: output };
  }

  function validateAtt(input, regIds, mode) {
    if (input === undefined || input === null) return bad("att", "مطلوب");
    if (!isPlainObject(input)) return bad("att", "يجب أن يكون كائنا");
    const keyError = checkKeys(input, "att");
    if (keyError) return keyError;
    const output = {};
    for (const day of Object.keys(input)) {
      const dayPath = "att." + day;
      if (!(mode === "load" && day === "") && !validDate(day)) {
        return bad(dayPath, "تاريخ غير صالح");
      }
      const entries = input[day];
      if (!isPlainObject(entries)) return bad(dayPath, "يجب أن يكون كائنا");
      const entriesKeyError = checkKeys(entries, dayPath);
      if (entriesKeyError) return entriesKeyError;
      output[day] = {};
      for (const rid of Object.keys(entries)) {
        if (!validId(rid)) return bad(dayPath + "." + rid, "معرف التسجيل غير صالح");
        if (!regIds.has(rid)) return bad(dayPath + "." + rid, "التسجيل غير موجود");
        if (typeof entries[rid] !== "boolean") return bad(dayPath + "." + rid, "يجب أن يكون صحيحا أو خطأ");
        output[day][rid] = entries[rid];
      }
    }
    return { ok: true, data: output };
  }

  function validatePrices(input) {
    if (input === undefined || input === null) return { ok: true, data: {} };
    if (!isPlainObject(input)) return bad("prices", "يجب أن يكون كائنا");
    const keyError = checkKeys(input, "prices");
    if (keyError) return keyError;
    const output = {};
    for (const key of Object.keys(input)) {
      if (key.length === 0 || key.length > MAX_PRICE_KEY_LENGTH) return bad("prices." + key, "مفتاح غير صالح");
      const price = optionalNumber(input[key], undefined, 0, "prices." + key, MAX_MONEY);
      if (!price.ok) return price;
      if (price.value === undefined) return bad("prices." + key, "قيمة مطلوبة");
      output[key] = price.value;
    }
    return { ok: true, data: output };
  }

  function validateSubjects(input) {
    if (input === undefined || input === null) return { ok: true, data: [] };
    if (!Array.isArray(input)) return bad("subjects", "يجب أن تكون لائحة");
    const output = [];
    const ids = new Set();
    const names = new Set();
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      const path = "subjects[" + index + "]";
      if (!isPlainObject(item)) return bad(path, "يجب أن يكون كائنا");
      const keyError = checkKeys(item, path);
      if (keyError) return keyError;
      if (!validId(item.id)) return bad(path + ".id", "معرف غير صالح");
      if (ids.has(item.id)) return bad(path + ".id", "معرف مكرر");
      ids.add(item.id);
      const act = requiredString(item.act, 200, path + ".act");
      if (!act.ok) return act;
      if (!Object.prototype.hasOwnProperty.call(ACT, act.value)) {
        return bad(path + ".act", "نشاط غير صالح");
      }
      const name = requiredString(item.name, MAX_PRICE_KEY_LENGTH, path + ".name");
      if (!name.ok) return name;
      const normalized = normalizeSubjectName(name.value);
      if (normalized === "") return bad(path + ".name", "مطلوب");
      if (normalized.length > maxSubjectNameLength(act.value)) return bad(path + ".name", "طويل جدا");
      if (normalized.includes("|")) return bad(path + ".name", "اسم غير صالح");
      const key = act.value + "|" + normalized;
      if (key.length > MAX_PRICE_KEY_LENGTH) return bad(path + ".name", "طويل جدا");
      if (names.has(key)) return bad(path + ".name", "مادة مكررة");
      if (ACT[act.value].includes(normalized)) return bad(path + ".name", "مادة أساسية موجودة");
      names.add(key);
      output.push({
        id: item.id,
        act: act.value,
        name: normalized,
      });
    }
    return { ok: true, data: output };
  }

  function validateCfg(input) {
    if (input === undefined || input === null) return { ok: true, data: { name: "تسيير المركز", logo: "" } };
    if (!isPlainObject(input)) return bad("cfg", "يجب أن يكون كائنا");
    const keyError = checkKeys(input, "cfg");
    if (keyError) return keyError;
    const name = optionalString(input.name, "تسيير المركز", 200, "cfg.name");
    if (!name.ok) return name;
    const logo = optionalString(input.logo, "", MAX_LOGO_LENGTH, "cfg.logo");
    if (!logo.ok) return logo;
    if (!validLogo(logo.value)) return bad("cfg.logo", "شعار غير صالح");
    return { ok: true, data: { name: name.value, logo: logo.value } };
  }

  function validateData(input, options) {
    const mode = options && options.mode === "import" ? "import" : "load";
    if (!isPlainObject(input)) return bad("root", "يجب أن يكون كائنا");
    const rootKeyError = checkKeys(input, "root");
    if (rootKeyError) return rootKeyError;

    const students = validateStudents(input.students, mode);
    if (!students.ok) return students;
    const regs = validateRegs(input.regs, mode, students.ids);
    if (!regs.ok) return regs;
    const pays = validatePays(input.pays, regs.ids, mode);
    if (!pays.ok) return pays;
    const att = validateAtt(input.att, regs.ids, mode);
    if (!att.ok) return att;
    const prices = validatePrices(input.prices);
    if (!prices.ok) return prices;
    const subjects = validateSubjects(input.subjects);
    if (!subjects.ok) return subjects;
    const cfg = validateCfg(input.cfg);
    if (!cfg.ok) return cfg;

    const pricesData = Object.assign({}, prices.data);
    const rawSubjects = Array.isArray(input.subjects) ? input.subjects : [];
    for (let index = 0; index < rawSubjects.length; index += 1) {
      const raw = rawSubjects[index];
      const subject = subjects.data[index];
      if (!isPlainObject(raw) || !subject || typeof raw.name !== "string") continue;
      const oldKey = subject.act + "|" + raw.name;
      const newKey = subject.act + "|" + subject.name;
      if (oldKey === newKey) continue;
      if (Object.prototype.hasOwnProperty.call(pricesData, oldKey) &&
          !Object.prototype.hasOwnProperty.call(pricesData, newKey)) {
        pricesData[newKey] = pricesData[oldKey];
      }
    }

    if (mode === "import") {
      return ok({
        students: students.data,
        regs: regs.data,
        att: att.data,
        pays: pays.data,
        prices: pricesData,
        subjects: subjects.data,
        cfg: cfg.data,
      });
    }
    const loaded = Object.assign({}, input);
    loaded.prices = pricesData;
    loaded.subjects = subjects.data;
    loaded.cfg = Object.assign({}, input.cfg || {}, {
      name: cfg.data.name,
      logo: cfg.data.logo,
    });
    return ok(loaded);
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, function (char) {
      if (char === "&") return "&amp;";
      if (char === "<") return "&lt;";
      if (char === ">") return "&gt;";
      if (char === '"') return "&quot;";
      return "&#39;";
    });
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function localDate(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function localMonth(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1);
  }

  function localTimestamp(date) {
    return localDate(date) + "_" + pad2(date.getHours()) + "-" + pad2(date.getMinutes()) + "-" +
      pad2(date.getSeconds()) + "-" + String(date.getMilliseconds()).padStart(3, "0");
  }

  return {
    MAX_JSON_BYTES: MAX_JSON_BYTES,
    MAX_LOGO_LENGTH: MAX_LOGO_LENGTH,
    MAX_MONEY: MAX_MONEY,
    MAX_PAYMENT_MONTHS: MAX_PAYMENT_MONTHS,
    MAX_PRICE_KEY_LENGTH: MAX_PRICE_KEY_LENGTH,
    ACT: ACT,
    normalizeSubjectName: normalizeSubjectName,
    maxSubjectNameLength: maxSubjectNameLength,
    validDate: validDate,
    validMonth: validMonth,
    validId: validId,
    validLogo: validLogo,
    validateData: validateData,
    escapeHtml: escapeHtml,
    localDate: localDate,
    localMonth: localMonth,
    localTimestamp: localTimestamp,
  };
});
