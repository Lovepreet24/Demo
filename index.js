const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const E = process.env;
for (const k of ["BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!E[k]) { console.error("Missing env variable: " + k); process.exit(1); }
}
const db = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY);

const CFG = {
  DAILY_MAX: 10, PER_REF: 5, TREAT: 1, BONUS: 0.5,
  CODE: (E.DAILY_CODE || "BOO17WEEN").toUpperCase(),
  TASKS: { ch: { r: 2, chat: E.CHANNEL_ID }, gr: { r: 1, chat: E.GROUP_ID }, tw: { r: 0.5 } }
};
const NETS = {
  bep20: /^0x[a-fA-F0-9]{40}$/,
  trc20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ton: /^(UQ|EQ)[\w-]{46}$/
};

const app = express();
app.use(express.json());
app.use(cors({ origin: E.ALLOWED_ORIGINS ? E.ALLOWED_ORIGINS.split(",") : true }));

// ---- Telegram login check (initData signature) ----
function auth(initData) {
  const p = new URLSearchParams(initData || "");
  const hash = p.get("hash");
  p.delete("hash");
  const str = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + "=" + v).join("\n");
  const key = crypto.createHmac("sha256", "WebAppData").update(E.BOT_TOKEN).digest();
  const h = crypto.createHmac("sha256", key).update(str).digest("hex");
  if (!hash || h !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  try { return { user: JSON.parse(p.get("user")), start: p.get("start_param") || "" }; } catch { return null; }
}

const day = () => new Date().toISOString().slice(0, 10);
const bad = (m) => { const e = new Error(m); e.user = true; throw e; };
const addBal = (id, amt) => db.rpc("add_balance", { uid: id, amt }).then(({ error }) => { if (error) throw error; });

// one request at a time per user (stops double claims)
const locks = new Map();
const withLock = (id, fn) => {
  const next = (locks.get(id) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(id, next.catch(() => {}));
  return next;
};

async function getUser(a) {
  const id = a.user.id;
  const { data: u } = await db.from("users").select("*").eq("id", id).maybeSingle();
  if (u) return u;
  let ref = null;
  const m = /^ref(\d+)$/.exec(a.start);
  if (m && Number(m[1]) !== id) {
    const { data: r } = await db.from("users").select("id").eq("id", m[1]).maybeSingle();
    if (r) ref = r.id;
  }
  const { data, error } = await db.from("users")
    .insert({ id, first_name: a.user.first_name || "Friend", referred_by: ref }).select().single();
  if (error) throw error;
  if (ref) await addBal(ref, CFG.PER_REF);
  return data;
}

async function state(id) {
  const { data: u } = await db.from("users").select("*").eq("id", id).single();
  const { data: f } = await db.from("users").select("id").eq("referred_by", id);
  return {
    bal: Number(u.balance), mineFrom: new Date(u.mine_from).getTime(),
    tasks: u.tasks, addr: u.addr, friends: (f || []).map((x) => x.id),
    codeDone: u.code_day === day(), bonusDone: u.bonus_day === day()
  };
}

const route = (name, fn) => app.post("/api/" + name, async (req, res) => {
  const a = auth(req.body.initData);
  if (!a) return res.status(401).json({ error: "Telegram se open karo" });
  try {
    await withLock(a.user.id, async () => {
      const u = await getUser(a);
      await fn(u, req.body);
      res.json({ state: await state(u.id) });
    });
  } catch (e) {
    if (e.user) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

const upd = (id, patch) => db.from("users").update(patch).eq("id", id).then(({ error }) => { if (error) throw error; });

route("me", async () => {});

route("claim", async (u) => {
  const m = Math.min(CFG.DAILY_MAX, ((Date.now() - new Date(u.mine_from).getTime()) / 86400000) * CFG.DAILY_MAX);
  if (m < 0.01) bad("Thoda ruko, reward ban raha hai");
  await addBal(u.id, Number(m.toFixed(5)));
  await upd(u.id, { mine_from: new Date().toISOString() });
});

route("code", async (u, b) => {
  if (u.code_day === day()) bad("Aaj ka code already use ho chuka");
  if (String(b.code || "").trim().toUpperCase() !== CFG.CODE) bad("Galat code");
  await addBal(u.id, CFG.TREAT);
  await upd(u.id, { code_day: day() });
});

route("bonus", async (u) => {
  if (u.bonus_day === day()) bad("Aaj ka bonus le liya, kal aana");
  await addBal(u.id, CFG.BONUS);
  await upd(u.id, { bonus_day: day() });
});

route("task", async (u, b) => {
  const T = CFG.TASKS[b.id];
  if (!T) bad("Task nahi mila");
  if (u.tasks[b.id]) bad("Task already complete");
  if (T.chat) {
    const r = await fetch(`https://api.telegram.org/bot${E.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(T.chat)}&user_id=${u.id}`).then((x) => x.json());
    if (!r.ok || !["member", "administrator", "creator"].includes(r.result.status)) bad("Pehle join karo, phir try karo");
  }
  await addBal(u.id, T.r);
  await upd(u.id, { tasks: { ...u.tasks, [b.id]: 1 } });
});

route("addr", async (u, b) => {
  const re = NETS[b.k];
  if (!re || !re.test(String(b.v || "").trim())) bad("Address sahi nahi hai");
  await upd(u.id, { addr: { ...u.addr, [b.k]: String(b.v).trim() } });
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(E.PORT || 3000, () => console.log("Halloween Rewards backend running"));
