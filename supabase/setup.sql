-- Country Quiz: database setup. Paste into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.

-- Every answer you give, from every device (append-only).
create table if not exists public.answers (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  t bigint not null,                 -- when you answered (ms since 1970)
  country text not null,
  mode text not null check (mode in ('find', 'name')),
  correct boolean not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists answers_user_created on public.answers (user_id, created_at);

-- Memory hooks, one per country (latest edit wins).
create table if not exists public.notes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  country text not null,
  text text not null,
  at bigint not null,
  primary key (user_id, country)
);

-- Best timed-challenge score per region (and 'world').
create table if not exists public.best_scores (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  scope text not null,
  found int not null,
  total int not null,
  ms bigint not null,
  at bigint not null,
  primary key (user_id, scope)
);

-- Row level security: each signed-in person can only see and change their own rows.
alter table public.answers enable row level security;
alter table public.notes enable row level security;
alter table public.best_scores enable row level security;

drop policy if exists "own answers" on public.answers;
create policy "own answers" on public.answers for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own best scores" on public.best_scores;
create policy "own best scores" on public.best_scores for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
