# Moving [App name] from Lovable Cloud to your own Supabase: your steps

I prepare the new project, the schema and the tools; the steps below touch your users' data, so **you** run them (unless we have signed a data processing agreement). Each step takes a few minutes. Do steps 3-6 in one sitting: anything your users save in the old app after the export is not moved.

## 1. Create the new Supabase project (5 min)
1. Go to supabase.com → **New project**. Region: [closest to your users, e.g. West EU (Ireland)]. Choose a strong database password and keep it in your password manager.
2. **Settings → Team → Invite** me with the email [email] while the project is empty. I set up the schema, sign-in and functions. I never need the old project's credentials.

## 2. Wait for my "ready for data" message
I will confirm that the schema matches your current database (you run one query for that: `counts.sql`, I send it to you).

## 3. Export your data from Lovable (5 min + waiting for the email)
1. In your project: **More → Cloud → Overview → Advanced settings → Export project data → Export data**.
2. In the **Database** card: **Export** → **Start export**.
3. Download it from the email link (or **More → Cloud → Storage**). Keep it on your computer, not in a shared folder: it contains all your users' data.

## 4. Download your files (only if you use Storage)
**More → Cloud → Storage**: download each bucket into a folder called `files/<bucket name>/`, keeping sub-folders.

## 5. Import (15 min)
Open a terminal in the folder where I sent you the toolkit and run:
```
node extract-data.mjs <your export file> --out data.sql
psql "<connection string of the NEW project>" --single-transaction -v ON_ERROR_STOP=1 -f data.sql
```
The connection string is in the new project: **Connect → Session pooler**. If you do not have `psql`, I will send you a one-line alternative with Docker.

Files:
```
SUPABASE_URL=https://<new project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<new project secret key> node upload-storage.mjs files
```

## 6. Check and switch
1. Run `counts.sql` and `counts-auth.sql` in the SQL editor of the old (Lovable: **More → Cloud → Database**) and the new project, and send me both results. I compare them and confirm every table, user and file is there.
2. I point the app to the new project and publish it. Everyone signs in again once; passwords stay the same.
3. **Do not remove Lovable Cloud yet.** Keep it for [7] days as a fallback. After that, delete your export file and `data.sql`.

From now on, backups and the security of the backend are in your hands: I explain the options (daily backups, point-in-time recovery) in the report.
