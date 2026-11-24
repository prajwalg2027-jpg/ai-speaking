-- Placement tests that survive a break (docs/PLACEMENT.md, "When a learner leaves midway"): the running test is
-- saved after every turn, so the learner can carry on after closing the app, a lost connection or a server
-- release, within the resume window (Settings › Limits). A test not carried on in time is marked 'abandoned'.
alter table assessments add column state jsonb;                 -- the test as the server holds it (personal: cleared on erasure and when it ends)
alter table assessments add column state_saved_at timestamptz;  -- when it was last saved: the window counts from here
alter table assessments add column resumes int not null default 0; -- how often the learner came back to it
create index assessments_open_idx on assessments (user_id, state_saved_at) where status = 'in_progress';
