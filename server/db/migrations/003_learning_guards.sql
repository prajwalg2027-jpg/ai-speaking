-- At most one tutor reply per learner message, so a retried or doubled request can never save a reply (and its
-- corrections and learning evidence) twice.
create unique index messages_one_reply_idx on messages (reply_to) where role = 'tutor';

-- Levels can also move from practice in the learning module (evidence-based; server/learning/progress.js).
alter table level_history drop constraint level_history_source_check;
alter table level_history add constraint level_history_source_check check (source in ('placement', 'lesson', 'support', 'practice'));

-- An exercise's short explanation, shown with the right answer.
alter table exercises add column explanation text;
