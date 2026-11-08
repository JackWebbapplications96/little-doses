(() => {
  const cfg = window.LITTLE_DOSES_CONFIG || {};
  const app = document.getElementById("app");
  const sheet = document.getElementById("sheet");
  const sheetForm = document.getElementById("sheet-form");
  const toastEl = document.getElementById("toast");

  const configured = cfg.supabaseUrl && cfg.supabaseKey && !cfg.supabaseUrl.includes("YOUR-PROJECT");
  if (!configured || !window.supabase) {
    app.innerHTML = `<div class="empty"><h2>Almost there</h2>
      <p>Add your Supabase project URL and key to <b>config.js</b>, then reload. The README walks through it.</p></div>`;
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const UNITS = ["ml", "mg", "mcg", "drops", "tablets", "sachets"];
  const FEED_TYPES = { expressed: "Expressed milk", formula: "Formula", breastfeed: "Breastfeed" };
  const state = {
    session: null,
    tab: "today",
    day: isoDate(new Date()),
    meds: [],
    stock: {},
    doses: [],
    feeds: [],
    plans: [],
    feedsReady: true,
    loaded: false,
    live: false,
    busy: new Set(),
  };

  // ---------- helpers ----------
  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function parseDay(iso) { return new Date(`${iso}T00:00:00`); }
  function addDays(iso, n) { const d = parseDay(iso); d.setDate(d.getDate() + n); return isoDate(d); }
  function today() { return isoDate(new Date()); }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmt(n) { return String(Math.round(Number(n) * 100) / 100); }
  function clock(ts) { return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
  function shortDate(iso) { return parseDay(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
  function dayName(iso) {
    const t = today();
    if (iso === t) return "Today";
    if (iso === addDays(t, -1)) return "Yesterday";
    if (iso === addDays(t, 1)) return "Tomorrow";
    return parseDay(iso).toLocaleDateString("en-GB", { weekday: "long" });
  }
  function myName() {
    const u = state.session?.user;
    if (!u) return "";
    if (u.user_metadata?.name) return u.user_metadata.name;
    const local = (u.email || "").split("@")[0];
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  function medById(id) { return state.meds.find(m => m.id === id); }

  function supply(med) {
    const remaining = Number(state.stock[med.id] ?? 0);
    const perDay = med.times.length ? Number(med.dose_amount) * med.times.length : null;
    const daysLeft = perDay ? remaining / perDay : null;
    let level = "ok";
    if (remaining <= 0) level = "out";
    else if (daysLeft !== null && daysLeft <= 2) level = "crit";
    else if (daysLeft !== null && daysLeft <= med.reorder_days) level = "warn";
    const runOut = daysLeft !== null ? addDays(today(), Math.floor(daysLeft)) : null;
    return { remaining, perDay, daysLeft, level, runOut };
  }
  function needsOrder(med) {
    return med.active && supply(med).level !== "ok" && !med.ordered_on;
  }

  let toastTimer;
  function toast(msg, action) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = esc(msg) + (action ? ` <button class="link" type="button" style="color:var(--accent);margin-left:8px">${esc(action.label)}</button>` : "");
    toastEl.hidden = false;
    if (action) toastEl.querySelector("button").onclick = () => { toastEl.hidden = true; action.run(); };
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, action ? 6000 : 3000);
  }
  function fail(err) {
    console.error(err);
    toast(err?.message ? `Couldn't save: ${err.message}` : "Couldn't save. Check your connection and try again.");
  }

  // ---------- data ----------
  async function load() {
    const [m, s, d, f, p] = await Promise.all([
      sb.from("medications").select("*").order("created_at"),
      sb.from("medication_stock").select("*"),
      sb.from("doses").select("*").eq("day", state.day).order("given_at"),
      sb.from("feeds").select("*").eq("day", state.day).order("fed_at"),
      sb.from("feed_plans").select("*").order("starts_on"),
    ]);
    const err = m.error || s.error || d.error;
    if (err) { fail(err); return; }
    state.meds = m.data;
    state.stock = Object.fromEntries(s.data.map(r => [r.medication_id, r.remaining]));
    state.doses = d.data;
    const feedErr = f.error || p.error;
    // Feed tables come from feeds.sql; until it's been run, the rest of the app still works.
    state.feedsReady = !feedErr;
    if (feedErr && !["PGRST205", "42P01"].includes(feedErr.code)) fail(feedErr);
    state.feeds = f.data || [];
    state.plans = p.data || [];
    state.loaded = true;
    render();
  }
  let refreshTimer;
  function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 250); }

  let channel;
  function subscribe() {
    if (channel) return;
    channel = sb.channel("household")
      .on("postgres_changes", { event: "*", schema: "public" }, refreshSoon)
      .subscribe(status => { state.live = status === "SUBSCRIBED"; renderLive(); });
  }

  // ---------- rendering ----------
  function render() {
    if (!state.session) return renderLogin();
    if (!state.loaded) { app.innerHTML = `<p class="boot">Loading…</p>`; return; }
    const orderCount = state.meds.filter(needsOrder).length;
    const views = { today: viewToday, feeds: viewFeeds, supplies: viewSupplies, meds: viewMeds };
    app.innerHTML = `
      <header class="top">
        <div class="brand"><img src="icon.svg" width="30" height="30" alt="">Little Doses</div>
        <span class="live" id="live"></span>
      </header>
      <main>${views[state.tab]()}</main>
      <nav class="tabs" aria-label="Sections">
        ${tabBtn("today", "Today")}
        ${tabBtn("feeds", "Feeds")}
        ${tabBtn("supplies", "Supplies", orderCount)}
        ${tabBtn("meds", "Medicines")}
      </nav>`;
    renderLive();
  }
  function tabBtn(id, label, badge) {
    return `<button type="button" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ""}>${label}${badge ? `<span class="badge">${badge}</span>` : ""}</button>`;
  }
  function renderLive() {
    const el = document.getElementById("live");
    if (!el) return;
    el.className = "live" + (state.live ? " on" : "");
    el.textContent = state.live ? "Synced" : "Offline";
  }

  function scheduleFor(day) {
    const slots = new Map();
    const prn = [];
    for (const med of state.meds) {
      const doses = state.doses.filter(d => d.medication_id === med.id);
      const started = isoDate(new Date(med.created_at)) <= day;
      if (!doses.length && (!med.active || !started)) continue;
      if (!med.times.length) {
        if (med.active || doses.length) prn.push({ med, doses });
        continue;
      }
      const times = new Set(med.active && started ? med.times : []);
      doses.forEach(d => { if (!d.slot.startsWith("prn-")) times.add(d.slot); });
      for (const t of times) {
        if (!slots.has(t)) slots.set(t, []);
        slots.get(t).push({ med, dose: doses.find(d => d.slot === t) });
      }
    }
    return { slots: [...slots.entries()].sort(([a], [b]) => a.localeCompare(b)), prn };
  }

  function doseStatus(day, time, dose) {
    if (dose) return "given";
    const t = today();
    if (day > t) return "upcoming";
    if (day < t) return "missed";
    const [hh, mm] = time.split(":").map(Number);
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const at = hh * 60 + mm;
    if (mins < at - 60) return "upcoming";
    if (mins <= at + 60) return "due";
    return "late";
  }

  function viewToday() {
    const day = state.day;
    const { slots, prn } = scheduleFor(day);
    const total = slots.reduce((n, [, items]) => n + items.length, 0);
    const given = slots.reduce((n, [, items]) => n + items.filter(i => i.dose).length, 0);
    const alerts = state.meds.filter(needsOrder).map(med => {
      const s = supply(med);
      const msg = s.level === "out" ? "Out of stock"
        : `${Math.floor(s.daysLeft)} day${Math.floor(s.daysLeft) === 1 ? "" : "s"} left · runs out ${shortDate(s.runOut)}`;
      return `<button type="button" class="alert ${s.level === "warn" ? "" : "crit"}" data-tab="supplies">
        <div><strong>Order more ${esc(med.name)}</strong><span>${msg}</span></div></button>`;
    }).join("");
    const isFuture = day > today();

    let body;
    if (!state.meds.some(m => m.active)) {
      body = `<div class="empty"><h2>No medicines yet</h2>
        <p>Add her medicines with their dose and times, and each day's doses will appear here to tick off.</p>
        <button type="button" class="btn primary" data-action="add-med">Add a medicine</button></div>`;
    } else if (!slots.length && !prn.length) {
      body = `<div class="empty"><p>Nothing scheduled for this day.</p></div>`;
    } else {
      body = `<div class="schedule">
        ${slots.map(([time, items]) => {
          const anyDue = items.some(i => ["due", "late"].includes(doseStatus(day, time, i.dose)));
          return `<section class="slot ${anyDue ? "now" : ""}"><div class="time">${esc(time)}</div><div class="rows">
            ${items.map(i => doseRow(i.med, time, i.dose, doseStatus(day, time, i.dose), isFuture)).join("")}
          </div></section>`;
        }).join("")}
        ${prn.length ? `<section class="slot"><div class="time">Any</div><div class="rows">
          ${prn.map(({ med, doses }) => `
            ${doses.map(d => doseRow(med, d.slot, d, "given", false)).join("")}
            <button type="button" class="dose" data-action="give-prn" data-med="${med.id}" ${isFuture ? "disabled" : ""}>
              <span class="tick"></span>
              <span class="what"><strong>${esc(med.name)}</strong><span>${fmt(med.dose_amount)} ${esc(med.unit)} · as needed</span></span>
              <span class="state">Log dose</span>
            </button>`).join("")}
        </div></section>` : ""}
      </div>`;
    }

    return `
      ${dayBar(total ? `${given} of ${total} given` : "", total ? given / total : null)}
      ${alerts}
      ${feedStrip(day)}
      ${body}`;
  }

  function dayBar(summary, fraction) {
    const day = state.day;
    return `
      <div class="daybar">
        <button type="button" class="icon-btn" data-action="prev-day" aria-label="Previous day">‹</button>
        <div class="day"><strong>${dayName(day)}</strong><span>${parseDay(day).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}${summary ? ` · ${summary}` : ""}</span></div>
        <button type="button" class="icon-btn" data-action="next-day" aria-label="Next day">›</button>
      </div>
      ${fraction !== null ? `<div class="progress"><i style="width:${Math.min(1, fraction) * 100}%"></i></div>` : ""}
      ${day !== today() ? `<div class="back-today"><button type="button" class="link" data-action="go-today">Back to today</button></div>` : ""}`;
  }

  // ---------- feeds ----------
  function planFor(day) {
    return state.plans.filter(p => p.starts_on <= day).pop() || null;
  }

  function feedDay(day) {
    const plan = planFor(day);
    const feeds = state.feeds;
    const total = feeds.reduce((n, f) => n + Number(f.amount_ml || 0), 0);
    const times = plan?.times || [];
    const planned = plan ? Number(plan.amount_per_feed || (times.length ? plan.target_ml / times.length : 0)) : 0;
    const slots = times.map(time => {
      const feed = feeds.find(f => f.slot === time);
      return { time, feed, status: doseStatus(day, time, feed) };
    });
    const extras = feeds.filter(f => !f.slot || !times.includes(f.slot));
    const left = slots.filter(s => !s.feed && ["upcoming", "due"].includes(s.status));
    const toGo = plan ? Math.max(0, plan.target_ml - total) : 0;
    const last = feeds.length ? feeds[feeds.length - 1] : null;
    return { plan, total, planned, slots, extras, left, toGo, last };
  }

  function ago(ts) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(ts)) / 60000));
    if (mins < 60) return `${mins} min ago`;
    return `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
  }

  function feedProgressText(fd, day) {
    if (!fd.plan) return "No daily target set yet.";
    if (fd.total >= fd.plan.target_ml) return "Daily target reached.";
    if (day === today() && fd.left.length) {
      const n = fd.left.length;
      return `${fmt(fd.toGo)} ml to go · ${n} feed${n === 1 ? "" : "s"} left, about ${Math.ceil(fd.toGo / n)} ml each.`;
    }
    if (day > today()) return `${fmt(fd.plan.target_ml)} ml planned.`;
    return `${fmt(fd.toGo)} ml short of the daily target.`;
  }

  function feedStrip(day) {
    if (!state.feedsReady) return "";
    const fd = feedDay(day);
    if (!fd.plan && !state.feeds.length) return "";
    const next = day === today() && fd.left[0];
    return `<button type="button" class="feed-strip" data-tab="feeds">
      <div><strong>Feeds</strong><span>${fmt(fd.total)}${fd.plan ? ` of ${fmt(fd.plan.target_ml)}` : ""} ml${next ? ` · next ${next.time}` : ""}</span></div>
      ${fd.plan ? `<div class="progress"><i style="width:${Math.min(100, (fd.total / fd.plan.target_ml) * 100)}%"></i></div>` : ""}
    </button>`;
  }

  function viewFeeds() {
    if (!state.feedsReady) {
      return `<div class="empty"><h2>One more step</h2>
        <p>Run <b>feeds.sql</b> in the Supabase SQL Editor to switch on feed tracking, then reload this page.</p></div>`;
    }
    const day = state.day;
    const fd = feedDay(day);
    const isFuture = day > today();
    const n = fd.slots.length;
    const done = fd.slots.filter(s => s.feed).length;

    const entries = [
      ...fd.slots.map(s => ({ time: s.time, html: feedRow(s.time, s.feed, s.status, fd.planned, isFuture) })),
      ...fd.extras.map(f => ({ time: clock(f.fed_at), html: feedRow(null, f, "given", 0, false) })),
    ].sort((a, b) => a.time.localeCompare(b.time));

    return `
      ${dayBar(n ? `${done} of ${n} feeds` : "", null)}
      <section class="feed-card">
        <div class="feed-total"><span class="big">${fmt(fd.total)}</span><span>${fd.plan ? `of ${fmt(fd.plan.target_ml)} ml in 24 hours` : "ml today"}</span></div>
        ${fd.plan ? `<div class="progress"><i style="width:${Math.min(100, (fd.total / fd.plan.target_ml) * 100)}%"></i></div>` : ""}
        <p class="meta">${feedProgressText(fd, day)}</p>
        ${day === today() && fd.last ? `<p class="meta">Last fed at ${clock(fd.last.fed_at)}, ${ago(fd.last.fed_at)}.</p>` : ""}
      </section>
      <div class="feed-actions">
        <button type="button" class="btn primary" data-action="extra-feed" ${isFuture ? "disabled" : ""}>Log a feed</button>
        <button type="button" class="btn" data-action="edit-plan">${fd.plan ? "Feeding plan" : "Set up feeding plan"}</button>
      </div>
      ${entries.length ? `<div class="schedule">${entries.map(e => `
        <section class="slot"><div class="time">${esc(e.time)}</div><div class="rows">${e.html}</div></section>`).join("")}</div>`
        : `<div class="empty"><p>${fd.plan ? "No feeds logged on this day." : "Set up her feeding plan to get a schedule and a daily target, or just log feeds as they happen."}</p></div>`}`;
  }

  function feedRow(slot, feed, status, planned, disabled) {
    const labels = { due: "Due now", late: "Overdue", missed: "Not logged", upcoming: "" };
    let title, detail;
    if (feed) {
      title = feed.amount_ml != null ? `${fmt(feed.amount_ml)} ml` : FEED_TYPES[feed.type];
      detail = [feed.amount_ml != null ? FEED_TYPES[feed.type] : "", feed.duration_min ? `${feed.duration_min} min` : "", slot ? "" : "extra feed"]
        .filter(Boolean).join(" · ");
    } else {
      title = "Feed";
      detail = planned ? `${fmt(Math.round(planned))} ml planned` : "";
    }
    const stateText = feed ? `${clock(feed.fed_at)}${feed.given_by ? `<br>${esc(feed.given_by)}` : ""}` : labels[status];
    return `<button type="button" class="dose ${feed ? "given" : status}" data-action="${feed ? "edit-feed" : "log-feed"}"
        ${slot ? `data-slot="${esc(slot)}"` : ""} ${feed ? `data-feed="${feed.id}"` : ""}
        ${disabled && !feed ? "disabled" : ""}>
      <span class="tick"></span>
      <span class="what"><strong>${esc(title)}</strong><span>${esc(detail)}</span>
        ${feed?.note ? `<span class="note">${esc(feed.note)}</span>` : ""}</span>
      <span class="state">${stateText}</span>
    </button>`;
  }

  function doseRow(med, slot, dose, status, disabled) {
    const labels = { due: "Due now", late: "Overdue", missed: "Not logged", upcoming: "" };
    const stateText = dose ? `${clock(dose.given_at)}${dose.given_by ? `<br>${esc(dose.given_by)}` : ""}` : labels[status];
    return `<button type="button" class="dose ${status}" data-action="${dose ? "dose-detail" : "give"}"
        data-med="${med.id}" data-slot="${esc(slot)}" ${dose ? `data-dose="${dose.id}"` : ""}
        ${disabled || state.busy.has(`${med.id}|${slot}`) ? "disabled" : ""}
        aria-label="${esc(med.name)} at ${esc(slot)}: ${dose ? "given" : status}">
      <span class="tick"></span>
      <span class="what"><strong>${esc(med.name)}</strong>
        <span>${fmt(dose ? dose.amount : med.dose_amount)} ${esc(med.unit)}${med.instructions ? ` · ${esc(med.instructions)}` : ""}</span>
        ${dose?.note ? `<span class="note">${esc(dose.note)}</span>` : ""}</span>
      <span class="state">${stateText}</span>
    </button>`;
  }

  function viewSupplies() {
    const meds = state.meds.filter(m => m.active);
    if (!meds.length) return `<div class="section-head"><div><h2>Supplies</h2></div></div>
      <div class="empty"><p>Add a medicine first. Its stock will be tracked here.</p></div>`;
    return `<div class="section-head"><div><h2>Supplies</h2><p>Counted down automatically as doses are ticked off.</p></div></div>
      <div class="supplies">${meds.map(med => {
        const s = supply(med);
        const pill = med.ordered_on && s.level !== "ok" ? `<span class="pill info">Ordered ${shortDate(med.ordered_on)}</span>`
          : { ok: `<span class="pill">Stocked</span>`, warn: `<span class="pill warn">Order soon</span>`,
              crit: `<span class="pill crit">Order now</span>`, out: `<span class="pill out">Out of stock</span>` }[s.level];
        return `<article class="supply">
          <header><h3>${esc(med.name)}</h3>${pill}</header>
          <div class="figures">
            <div><span class="big">${fmt(s.remaining)}</span><span class="u">${esc(med.unit)} left</span></div>
            <div><span class="big">${s.daysLeft === null ? "–" : Math.max(0, Math.floor(s.daysLeft))}</span><span class="u">days left</span></div>
            <div><span class="big sm">${s.runOut ? shortDate(s.runOut) : "As needed"}</span><span class="u">runs out</span></div>
          </div>
          <p class="meta">${s.perDay ? `${fmt(med.dose_amount)} ${esc(med.unit)} × ${med.times.length} a day = ${fmt(s.perDay)} ${esc(med.unit)} per day. Reminder at ${med.reorder_days} days left.` : `${fmt(med.dose_amount)} ${esc(med.unit)} per dose, given as needed.`}
            ${med.ordered_on ? ` Ordered on ${shortDate(med.ordered_on)}.` : ""}</p>
          ${med.order_info ? `<p class="order-info"><b>How to order</b>${esc(med.order_info)}</p>` : ""}
          <div class="actions">
            ${med.ordered_on
              ? `<button type="button" class="btn sm" data-action="unorder" data-med="${med.id}">Not ordered yet</button>`
              : `<button type="button" class="btn sm" data-action="ordered" data-med="${med.id}">I've ordered more</button>`}
            <button type="button" class="btn sm primary" data-action="delivery" data-med="${med.id}">Delivery arrived</button>
            <button type="button" class="btn sm" data-action="correct" data-med="${med.id}">Correct count</button>
          </div>
        </article>`;
      }).join("")}</div>`;
  }

  function viewMeds() {
    const meds = [...state.meds].sort((a, b) => Number(b.active) - Number(a.active));
    return `<div class="section-head"><div><h2>Medicines</h2><p>Doses, times and how to reorder.</p></div>
        <button type="button" class="btn primary sm" data-action="add-med">Add</button></div>
      ${meds.length ? `<ul class="med-list">${meds.map(m => `<li class="${m.active ? "" : "stopped"}">
        <button type="button" data-action="edit-med" data-med="${m.id}">
          <strong>${esc(m.name)}${m.active ? "" : " (stopped)"}</strong>
          <span>${fmt(m.dose_amount)} ${esc(m.unit)} · ${m.times.length ? m.times.join(", ") : "as needed"}</span>
        </button></li>`).join("")}</ul>`
        : `<div class="empty"><p>No medicines yet.</p></div>`}
      <h3 class="subhead">Signed in as ${esc(myName())}</h3>
      <div class="settings-row">
        <button type="button" class="btn sm" data-action="rename">Change my name</button>
        <button type="button" class="btn sm" data-action="sign-out">Sign out</button>
      </div>`;
  }

  function renderLogin() {
    app.innerHTML = `<div class="login">
      <div class="brand"><img src="icon.svg" width="40" height="40" alt="">Little Doses</div>
      <p>Sign in to see and log today's medicines.</p>
      <form id="login-form">
        <label class="field">Email<input id="login-email" type="email" autocomplete="username" required></label>
        <label class="field">Password<input id="login-password" type="password" autocomplete="current-password" required></label>
        <p class="form-error" id="login-error" hidden></p>
        <button class="btn primary" type="submit">Sign in</button>
      </form></div>`;
    document.getElementById("login-form").addEventListener("submit", async e => {
      e.preventDefault();
      const btn = e.target.querySelector("button");
      const errEl = document.getElementById("login-error");
      btn.disabled = true; errEl.hidden = true;
      const { error } = await sb.auth.signInWithPassword({
        email: document.getElementById("login-email").value.trim(),
        password: document.getElementById("login-password").value,
      });
      btn.disabled = false;
      if (error) { errEl.textContent = "That email and password didn't match. Check them and try again."; errEl.hidden = false; }
    });
  }

  // ---------- sheet ----------
  function openSheet(html, onSubmit, onMount) {
    sheetForm.innerHTML = html;
    sheetForm.onsubmit = async e => {
      e.preventDefault();
      const btn = e.submitter || sheetForm.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      try { if ((await onSubmit(new FormData(sheetForm), e.submitter)) !== false) sheet.close(); }
      catch (err) { fail(err); }
      finally { if (btn) btn.disabled = false; }
    };
    sheetForm.querySelectorAll("[data-close]").forEach(b => b.onclick = () => sheet.close());
    onMount?.(sheetForm);
    sheet.showModal();
  }
  sheet.addEventListener("click", e => { if (e.target === sheet) sheet.close(); });
  function formError(msg) {
    let el = sheetForm.querySelector(".form-error");
    if (!el) { el = document.createElement("p"); el.className = "form-error"; sheetForm.querySelector(".sheet-actions").before(el); }
    el.textContent = msg;
    return false;
  }

  // ---------- actions ----------
  async function give(med, slot) {
    const key = `${med.id}|${slot}`;
    if (state.busy.has(key)) return;
    state.busy.add(key); render();
    const { data, error } = await sb.from("doses").insert({
      medication_id: med.id, day: state.day, slot, amount: med.dose_amount, given_by: myName(),
    }).select().single();
    state.busy.delete(key);
    if (error) {
      if (error.code === "23505") toast("Already logged on the other phone");
      else fail(error);
      return load();
    }
    state.doses.push(data);
    state.stock[med.id] = Number(state.stock[med.id] ?? 0) - Number(data.amount);
    render();
    toast(`${med.name} given`, { label: "Undo", run: () => undoDose(data.id) });
  }

  async function undoDose(id) {
    const { error } = await sb.from("doses").delete().eq("id", id);
    if (error) return fail(error);
    toast("Dose removed");
    load();
  }

  function doseDetail(doseId) {
    const dose = state.doses.find(d => d.id === doseId);
    const med = dose && medById(dose.medication_id);
    if (!med) return;
    openSheet(`
      <h2 id="sheet-title">${esc(med.name)}</h2>
      <p class="sub">${fmt(dose.amount)} ${esc(med.unit)} given at ${clock(dose.given_at)}${dose.given_by ? ` by ${esc(dose.given_by)}` : ""}</p>
      <label class="field">Note <small>e.g. brought some back up, given with feed</small>
        <textarea id="dose-note" name="note">${esc(dose.note)}</textarea></label>
      <div class="sheet-actions">
        <button type="submit" class="btn danger" name="op" value="undo">Undo this dose</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-close>Close</button>
        <button type="submit" class="btn primary" name="op" value="save">Save note</button>
      </div>`,
    async (fd, submitter) => {
      if (submitter?.value === "undo") { await undoDose(dose.id); return; }
      const { error } = await sb.from("doses").update({ note: fd.get("note").trim() || null }).eq("id", dose.id);
      if (error) throw error;
      toast("Note saved"); load();
    });
  }

  function medForm(med) {
    const isNew = !med;
    const m = med || { name: "", dose_amount: "", unit: "ml", times: ["08:00"], instructions: "", reorder_days: 7, order_info: "", active: true };
    const timeRow = t => `<div class="time-row"><input type="time" name="time" value="${esc(t)}" required aria-label="Dose time">
      <button type="button" class="btn" data-remove-time aria-label="Remove time">×</button></div>`;
    openSheet(`
      <h2 id="sheet-title">${isNew ? "Add a medicine" : `Edit ${esc(m.name)}`}</h2>
      <label class="field">Name<input id="med-name" name="name" value="${esc(m.name)}" placeholder="e.g. Sodium feredetate (Sytron)" required></label>
      <div class="row2">
        <label class="field">Dose<input id="med-dose" name="dose_amount" type="number" inputmode="decimal" step="any" min="0" value="${esc(m.dose_amount)}" required></label>
        <label class="field">Unit<input id="med-unit" name="unit" list="units" value="${esc(m.unit)}" required>
          <datalist id="units">${UNITS.map(u => `<option value="${u}">`).join("")}</datalist></label>
      </div>
      <fieldset><legend>Times each day <small style="font-weight:400;color:var(--muted)">(none = as needed)</small></legend>
        <div id="times">${m.times.map(timeRow).join("")}</div>
        <button type="button" class="link" data-add-time style="justify-self:start">+ Add a time</button>
      </fieldset>
      <label class="field">Instructions <small>optional</small><input id="med-instructions" name="instructions" value="${esc(m.instructions)}" placeholder="e.g. with a feed"></label>
      ${isNew ? `<label class="field">How much do you have now? <small>in the same unit, e.g. a 50 ml bottle = 50</small>
        <input id="med-stock" name="stock" type="number" inputmode="decimal" step="any" min="0" required></label>` : ""}
      <label class="field">Remind me to reorder at <small>days of supply left</small>
        <input id="med-reorder" name="reorder_days" type="number" inputmode="numeric" min="0" step="1" value="${esc(m.reorder_days)}" required></label>
      <label class="field">How to reorder <small>optional: pharmacy, GP repeat, phone number</small>
        <textarea id="med-order" name="order_info">${esc(m.order_info)}</textarea></label>
      ${isNew ? "" : `<div class="danger-zone">
        <button type="submit" class="btn sm" name="op" value="toggle">${m.active ? "Stop this medicine" : "Start again"}</button>
        <button type="submit" class="btn sm danger" name="op" value="delete" id="delete-btn">Delete</button></div>`}
      <div class="sheet-actions"><span class="spacer"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary" name="op" value="save">${isNew ? "Add medicine" : "Save"}</button></div>`,
    async (fd, submitter) => {
      const op = submitter?.value || "save";
      if (op === "toggle") {
        const { error } = await sb.from("medications").update({ active: !m.active }).eq("id", m.id);
        if (error) throw error;
        toast(m.active ? `${m.name} stopped` : `${m.name} started again`); return load();
      }
      if (op === "delete") {
        const btn = document.getElementById("delete-btn");
        if (!btn.dataset.armed) {
          btn.dataset.armed = "1"; btn.textContent = "Tap again to delete, with all its history";
          return false;
        }
        const { error } = await sb.from("medications").delete().eq("id", m.id);
        if (error) throw error;
        toast(`${m.name} deleted`); return load();
      }
      const row = {
        name: fd.get("name").trim(),
        dose_amount: Number(fd.get("dose_amount")),
        unit: fd.get("unit").trim() || "ml",
        times: [...new Set(fd.getAll("time").filter(Boolean))].sort(),
        instructions: fd.get("instructions").trim() || null,
        reorder_days: Math.max(0, parseInt(fd.get("reorder_days"), 10) || 0),
        order_info: fd.get("order_info").trim() || null,
      };
      if (!row.name) return formError("Give the medicine a name.");
      if (!(row.dose_amount > 0)) return formError("Enter the dose as a number above zero.");
      if (isNew) {
        const stock = Number(fd.get("stock"));
        if (!(stock >= 0) || fd.get("stock") === "") return formError("Enter how much you have now (0 if none).");
        const { data, error } = await sb.from("medications").insert(row).select().single();
        if (error) throw error;
        if (stock > 0) {
          const r = await sb.from("stock_events").insert({ medication_id: data.id, change: stock, reason: "starting stock", created_by: myName() });
          if (r.error) throw r.error;
        }
        toast(`${row.name} added`);
      } else {
        const { error } = await sb.from("medications").update(row).eq("id", m.id);
        if (error) throw error;
        toast("Saved");
      }
      return load();
    },
    form => {
      const box = form.querySelector("#times");
      form.querySelector("[data-add-time]").onclick = () => {
        box.insertAdjacentHTML("beforeend", timeRow("12:00"));
        box.lastElementChild.querySelector("input").focus();
      };
      box.addEventListener("click", e => { if (e.target.closest("[data-remove-time]")) e.target.closest(".time-row").remove(); });
      form.querySelector("#med-name").focus();
    });
  }

  function stockForm(med, kind) {
    const s = supply(med);
    const delivery = kind === "delivery";
    openSheet(`
      <h2 id="sheet-title">${delivery ? "Delivery arrived" : "Correct the count"}</h2>
      <p class="sub">${esc(med.name)} · currently ${fmt(s.remaining)} ${esc(med.unit)}</p>
      <label class="field">${delivery ? `How much arrived? <small>in ${esc(med.unit)}, e.g. a 100 ml bottle = 100</small>` : `How much is actually left? <small>in ${esc(med.unit)}</small>`}
        <input id="stock-amount" name="amount" type="number" inputmode="decimal" step="any" min="0" required></label>
      <div class="sheet-actions"><span class="spacer"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">${delivery ? "Add to stock" : "Set count"}</button></div>`,
    async fd => {
      const raw = fd.get("amount");
      const amount = Number(raw);
      if (raw === "" || !(amount >= 0)) return formError("Enter a number.");
      const change = delivery ? amount : amount - s.remaining;
      if (change !== 0) {
        const { error } = await sb.from("stock_events").insert({
          medication_id: med.id, change, reason: delivery ? "delivery" : "correction", created_by: myName(),
        });
        if (error) throw error;
      }
      if (delivery && med.ordered_on) {
        const { error } = await sb.from("medications").update({ ordered_on: null }).eq("id", med.id);
        if (error) throw error;
      }
      toast(delivery ? `Added ${fmt(amount)} ${med.unit}` : "Count updated");
      return load();
    },
    form => form.querySelector("#stock-amount").focus());
  }

  function feedForm(slot, feed) {
    const day = state.day;
    const fd = feedDay(day);
    const type = feed?.type || state.feeds[state.feeds.length - 1]?.type || fd.plan?.default_type || "expressed";
    const amount = feed ? (feed.amount_ml ?? "") : (fd.planned ? Math.round(fd.planned) : "");
    const time = feed ? clock(feed.fed_at) : day === today() ? clock(new Date()) : (slot || "12:00");
    openSheet(`
      <h2 id="sheet-title">${feed ? "Edit feed" : slot ? `${esc(slot)} feed` : "Log a feed"}</h2>
      ${feed ? `<p class="sub">Logged by ${esc(feed.given_by || "someone")}</p>` : ""}
      <fieldset><legend>Milk</legend><div class="seg">
        ${Object.entries(FEED_TYPES).map(([v, l]) => `<label><input type="radio" name="type" value="${v}" ${v === type ? "checked" : ""}><span>${l}</span></label>`).join("")}
      </div></fieldset>
      <div class="row2">
        <label class="field"><span id="amount-label">Amount (ml)</span><input id="feed-amount" name="amount" type="number" inputmode="decimal" step="any" min="0" value="${esc(amount)}"></label>
        <label class="field">Time<input id="feed-time" name="time" type="time" value="${esc(time)}" required></label>
      </div>
      <label class="field" id="duration-field">Minutes feeding <small>optional</small>
        <input id="feed-duration" name="duration" type="number" inputmode="numeric" min="0" step="1" value="${esc(feed?.duration_min ?? "")}"></label>
      <label class="field">Note <small>optional, e.g. via tube, fortifier added, brought some back up</small>
        <textarea id="feed-note" name="note">${esc(feed?.note)}</textarea></label>
      <div class="sheet-actions">
        ${feed ? `<button type="submit" class="btn danger" name="op" value="delete" id="feed-delete">Delete</button>` : ""}
        <span class="spacer"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary" name="op" value="save">${feed ? "Save" : "Log feed"}</button>
      </div>`,
    async (form, submitter) => {
      if (submitter?.value === "delete") {
        const btn = document.getElementById("feed-delete");
        if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Tap again to delete"; return false; }
        const { error } = await sb.from("feeds").delete().eq("id", feed.id);
        if (error) throw error;
        toast("Feed deleted"); return load();
      }
      const kind = form.get("type");
      const raw = form.get("amount");
      const ml = raw === "" ? null : Number(raw);
      if (kind !== "breastfeed" && !(ml > 0)) return formError("Enter how many ml she had.");
      if (ml !== null && !(ml >= 0)) return formError("Enter the amount as a number.");
      const t = form.get("time");
      if (!t) return formError("Enter the time of the feed.");
      const dur = form.get("duration");
      const row = {
        type: kind,
        amount_ml: ml,
        duration_min: kind === "breastfeed" && dur !== "" ? Math.max(0, parseInt(dur, 10) || 0) : null,
        fed_at: new Date(`${day}T${t}:00`).toISOString(),
        note: form.get("note").trim() || null,
      };
      if (feed) {
        const { error } = await sb.from("feeds").update(row).eq("id", feed.id);
        if (error) throw error;
        toast("Feed saved");
      } else {
        const { error } = await sb.from("feeds").insert({ ...row, day, slot: slot || null, given_by: myName() });
        if (error?.code === "23505") toast("That feed was just logged on the other phone");
        else if (error) throw error;
        else toast(ml != null ? `${fmt(ml)} ml logged` : "Feed logged");
      }
      return load();
    },
    form => {
      const sync = () => {
        const bf = form.querySelector('input[name="type"]:checked')?.value === "breastfeed";
        document.getElementById("duration-field").hidden = !bf;
        document.getElementById("amount-label").textContent = bf ? "Amount (ml, if known)" : "Amount (ml)";
      };
      form.querySelectorAll('input[name="type"]').forEach(r => r.addEventListener("change", sync));
      sync();
    });
  }

  function planForm() {
    const current = planFor(today());
    const p = current || {
      target_ml: "", amount_per_feed: "", default_type: "expressed",
      times: ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
    };
    const timeRow = t => `<div class="time-row"><input type="time" name="time" value="${esc(t)}" required aria-label="Feed time">
      <button type="button" class="btn" data-remove-time aria-label="Remove time">×</button></div>`;
    openSheet(`
      <h2 id="sheet-title">Feeding plan</h2>
      <p class="sub">Changes apply from today. Earlier days keep the plan they had.</p>
      <label class="field">Daily target <small>ml per 24 hours</small>
        <input id="plan-target" name="target_ml" type="number" inputmode="decimal" step="any" min="1" value="${esc(p.target_ml)}" required></label>
      <div class="calc">
        <span>Work it out:</span>
        <input id="calc-mlkg" type="number" inputmode="decimal" step="any" min="0" placeholder="150" aria-label="ml per kg per day"><span>ml/kg/day ×</span>
        <input id="calc-kg" type="number" inputmode="decimal" step="any" min="0" placeholder="2.4" aria-label="Weight in kg"><span>kg</span>
        <button type="button" class="btn sm" id="calc-go">Use</button>
      </div>
      <fieldset><legend>Feed times</legend>
        <div class="calc">
          <span>Every</span><input id="gen-hours" type="number" inputmode="decimal" step="any" min="1" max="12" value="3" aria-label="Hours between feeds">
          <span>hours from</span><input id="gen-start" type="time" value="${esc(p.times[0] || "06:00")}" aria-label="First feed time">
          <button type="button" class="btn sm" id="gen-go">Fill in</button>
        </div>
        <div id="times">${p.times.map(timeRow).join("")}</div>
        <button type="button" class="link" data-add-time style="justify-self:start">+ Add a time</button>
      </fieldset>
      <label class="field">Amount per feed <small>optional; leave blank to split the target evenly</small>
        <input id="plan-per-feed" name="amount_per_feed" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.amount_per_feed ?? "")}"></label>
      <label class="field">Usual milk
        <select id="plan-type" name="default_type">${Object.entries(FEED_TYPES).map(([v, l]) => `<option value="${v}" ${v === p.default_type ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <div class="sheet-actions"><span class="spacer"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">Save plan</button></div>`,
    async form => {
      const target = Number(form.get("target_ml"));
      if (!(target > 0)) return formError("Enter the daily target in ml.");
      const per = form.get("amount_per_feed");
      const row = {
        starts_on: today(),
        target_ml: target,
        times: [...new Set(form.getAll("time").filter(Boolean))].sort(),
        amount_per_feed: per === "" ? null : Number(per) || null,
        default_type: form.get("default_type"),
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from("feed_plans").upsert(row, { onConflict: "starts_on" });
      if (error) throw error;
      toast("Feeding plan saved");
      return load();
    },
    form => {
      const box = form.querySelector("#times");
      const perFeed = form.querySelector("#plan-per-feed");
      const target = form.querySelector("#plan-target");
      const hint = () => {
        const n = box.querySelectorAll("input").length;
        perFeed.placeholder = n && target.value ? `${Math.round(target.value / n)} ml (${n} feeds)` : "";
      };
      form.querySelector("[data-add-time]").onclick = () => { box.insertAdjacentHTML("beforeend", timeRow("12:00")); hint(); };
      box.addEventListener("click", e => { if (e.target.closest("[data-remove-time]")) { e.target.closest(".time-row").remove(); hint(); } });
      target.addEventListener("input", hint);
      form.querySelector("#calc-go").onclick = () => {
        const v = Number(form.querySelector("#calc-mlkg").value) * Number(form.querySelector("#calc-kg").value);
        if (v > 0) { target.value = Math.round(v); hint(); }
      };
      form.querySelector("#gen-go").onclick = () => {
        const h = Number(form.querySelector("#gen-hours").value);
        const start = form.querySelector("#gen-start").value;
        if (!(h >= 1) || !start) return;
        const [sh, sm] = start.split(":").map(Number);
        const times = [];
        for (let i = 0; i < Math.floor(24 / h); i++) {
          const m = (sh * 60 + sm + Math.round(i * h * 60)) % 1440;
          times.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
        }
        box.innerHTML = times.sort().map(timeRow).join("");
        hint();
      };
      hint();
    });
  }

  function renameForm() {
    openSheet(`
      <h2 id="sheet-title">Your name</h2>
      <p class="sub">Shown next to the doses you log.</p>
      <label class="field">Name<input id="my-name" name="name" value="${esc(myName())}" required></label>
      <div class="sheet-actions"><span class="spacer"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">Save</button></div>`,
    async fd => {
      const name = fd.get("name").trim();
      if (!name) return formError("Enter a name.");
      const { data, error } = await sb.auth.updateUser({ data: { name } });
      if (error) throw error;
      state.session = { ...state.session, user: data.user };
      toast("Name saved"); render();
    });
  }

  async function setOrdered(med, on) {
    const { error } = await sb.from("medications").update({ ordered_on: on ? today() : null }).eq("id", med.id);
    if (error) return fail(error);
    toast(on ? "Marked as ordered" : "Order cleared");
    load();
  }

  app.addEventListener("click", e => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const med = el.dataset.med && medById(el.dataset.med);
    switch (el.dataset.action) {
      case "prev-day": state.day = addDays(state.day, -1); state.doses = []; state.feeds = []; render(); load(); break;
      case "next-day": state.day = addDays(state.day, 1); state.doses = []; state.feeds = []; render(); load(); break;
      case "log-feed": feedForm(el.dataset.slot, null); break;
      case "extra-feed": feedForm(null, null); break;
      case "edit-feed": feedForm(null, state.feeds.find(f => f.id === el.dataset.feed)); break;
      case "edit-plan": planForm(); break;
      case "go-today": state.day = today(); load(); break;
      case "give": give(med, el.dataset.slot); break;
      case "give-prn": give(med, `prn-${Date.now()}`); break;
      case "dose-detail": doseDetail(el.dataset.dose); break;
      case "add-med": medForm(null); break;
      case "edit-med": medForm(med); break;
      case "ordered": setOrdered(med, true); break;
      case "unorder": setOrdered(med, false); break;
      case "delivery": stockForm(med, "delivery"); break;
      case "correct": stockForm(med, "correct"); break;
      case "rename": renameForm(); break;
      case "sign-out": sb.auth.signOut(); break;
    }
  });

  // Keep "due"/"overdue" labels current, and catch up after the phone wakes.
  let lastToday = today();
  setInterval(() => {
    if (!state.session || sheet.open) return;
    const t = today();
    if (t !== lastToday) { if (state.day === lastToday) state.day = t; lastToday = t; load(); }
    else if (state.tab === "today") render();
  }, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.session) load(); });

  sb.auth.onAuthStateChange((_event, session) => {
    const wasSignedIn = !!state.session;
    state.session = session;
    if (session && !wasSignedIn) { subscribe(); load(); }
    if (!session) {
      state.loaded = false;
      if (channel) { sb.removeChannel(channel); channel = null; }
    }
    render();
  });
})();
