# My Own Calendly — MVP

Personal Hebrew (RTL) booking app with two meeting types, real availability, Israel timezone, SQLite storage, admin bookings, cancellation and double-booking protection.

## Run

Requires Node.js **22.13+** (native `node:sqlite`). No npm dependencies.

1. Copy `.env.example` to `.env`.
2. Set a random `ADMIN_KEY` with at least 16 characters.
3. Run `npm start`.
4. Visit `http://localhost:3000` for public booking and `http://localhost:3000/admin` for admin.
5. Run `npm test` for automated checks.

## Current defaults

- Israel time (Asia/Jerusalem), Sunday–Thursday, 09:00–17:00.
- 30-minute intro or 60-minute session.
- Bookings up to 45 days in advance, minimum 2 hours notice.
- Date/time slots are allocated with SQLite locking and checked again when booking.
- Booking and cancellation are saved in the database under `data/`. This directory is gitignored.

## Limitations before real customers

**This is an MVP, not ready for public customer deployment as-is.** Google Calendar sync, email invitations, authentication, observability, backups, anti-abuse protection and deployment/storage still need work. The owner can see client personal details through admin access. Deploy behind HTTPS only and keep `ADMIN_KEY` secret. Do not use ephemeral storage in production; ensure durable SQLite storage or move to PostgreSQL. Booking conflicts are prevented inside this app, **not** against external Google Calendar events. Cancellation token must be stored by the booker, as there are no email notifications yet.

## Codex next steps

Add Google Calendar OAuth and FreeBusy integration securely, then email confirmations, admin-managed weekly hours and blackout dates, mobile QA, tests and deployment using a durable database. Never commit secrets.
