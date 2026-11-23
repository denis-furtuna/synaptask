-- Task stages, like the project board: To do -> Ongoing -> Done.
-- A task is Ongoing while started_at is set and completed_at is not; Done is completed_at as before.
alter table public.tasks add column started_at timestamptz;
