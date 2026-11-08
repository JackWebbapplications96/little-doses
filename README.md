# Little Doses

A small shared medicine tracker for a baby at home. Both parents sign in on their phones, tick off each dose as it's given, and see how much of each medicine is left, when it runs out and when to reorder.

- **Hosting:** GitHub Pages (static files, free)
- **Storage and login:** Supabase free tier (Postgres with live updates)

## What it does

- **Today:** each day's doses grouped by time. Tap a dose to mark it given, and it records who gave it and when. Tap a given dose to add a note or undo it. A dose logged on one phone shows up on the other straight away. Doses within an hour of their time are marked *Due now*, and doses later than that are marked *Overdue*. You can step back through earlier days.
- **Feeds:** a feeding plan with a daily target (ml per 24 hours, with an ml/kg/day × weight calculator) and feed times (or "every 3 hours from 06:00"). Log each scheduled feed or an extra one as expressed milk, formula or a breastfeed. It shows the running total against the target, how much is left to go and roughly how much per remaining feed, and when she was last fed. A summary also appears on *Today*.
- **Supplies:** remaining amount, days left and run-out date for each medicine, counted down automatically from the doses given. Orange means *order soon* (at the reminder threshold you set), and red means two days left or less. *I've ordered more* stops the nagging. *Delivery arrived* adds stock, and *Correct count* fixes any drift such as spills or bottle overfill.
- **Medicines:** add or edit dose, unit, daily times (none means *as needed*), instructions and how to reorder. You can stop a medicine without losing its history.

## One-time setup (about 10 minutes)

### 1. Supabase

1. Create a free account at [supabase.com](https://supabase.com) and add a **New project**. Choose a London region (`eu-west-2`) and any database password.
2. Open **SQL Editor → New query**, paste the contents of [`schema.sql`](schema.sql) and click **Run**. Do the same with [`feeds.sql`](feeds.sql).
3. In **Authentication → Sign In / Providers** (labelled *Settings* on some versions), turn **off** *Allow new users to sign up*. That way the only accounts are the two you create.
4. In **Authentication → Users → Add user → Create new user**, create one for each parent with an email and password, and tick **Auto Confirm User**.
5. In **Project Settings → API Keys** (or **API**), copy the **Project URL** and the **publishable** key (older projects call it the `anon` `public` key). Paste both into [`config.js`](config.js).

The publishable key is designed to be public. Nothing can be read or changed without signing in, which is enforced by the row-level security in `schema.sql`.

### 2. Publish

```sh
git add config.js && git commit -m "Add Supabase config" && git push
```

GitHub Pages redeploys within a minute or so.

### 3. On each phone

Open the site, sign in, then add it to the home screen. On iPhone use **Share → Add to Home Screen**, and in Chrome on Android use **⋮ → Add to Home screen**. It then opens like an app.

## Good to know

- **Free tier pause:** Supabase pauses free projects after 7 days with no activity. Daily use keeps it awake. If it ever does pause, press **Restore** in the Supabase dashboard; no data is lost.
- **Your data:** everything lives in your own Supabase project. **Table Editor** shows every dose and stock change if you ever need to show a nurse or GP the history.
- **Units:** keep stock in the same unit as the dose. For example, enter a 50 ml bottle as 50 when the dose is in ml.
- This is a record-keeping aid. Always follow the dosing your neonatal team or pharmacist gave you.
